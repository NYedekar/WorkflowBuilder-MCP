import { z } from "zod";
import type { BimElement } from "./extract-bim-data.js";

// ── Schema ─────────────────────────────────────────────────────────────────

export const pushToBimDashboardSchema = z.object({
  model_name: z.string().describe("Display name for the model in the dashboard. E.g. 'Demoland Building 1'"),
  file_type: z.enum(["RVT", "DWG", "IFC", "NWD", "XLSX", "OTHER"]).default("RVT").describe("File type of the source model."),
  discipline: z.enum(["Architecture", "Structure", "MEP", "Civil", "Multi", "Unknown"]).default("Unknown"),
  elements: z.array(z.object({
    element_id: z.number().nullable().optional(),
    category: z.string().nullable().optional(),
    family: z.string().nullable().optional(),
    family_type: z.string().nullable().optional(),
    level: z.string().nullable().optional(),
    phase_created: z.string().nullable().optional(),
    comments: z.string().nullable().optional(),
    mark: z.string().nullable().optional(),
    area: z.number().nullable().optional(),
    volume: z.number().nullable().optional(),
    length: z.number().nullable().optional(),
    structural: z.boolean().nullable().optional(),
  })).describe("Element array from extract_bim_data — pass the full elements array after human review."),
  reviewer_notes: z.string().optional().describe("Notes added during the human-touch review gate."),
  replace_existing: z.boolean().default(true).describe("If true (default), deletes existing elements for this model before inserting new ones — keeps the dashboard current."),
  level_count: z.number().int().optional(),
  sheet_count: z.number().int().optional(),
  view_count: z.number().int().optional(),
  warning_count: z.number().int().optional(),
});

export type PushToBimDashboardInput = z.infer<typeof pushToBimDashboardSchema>;

// ── Output ─────────────────────────────────────────────────────────────────

export interface PushToBimDashboardOutput {
  status: "success" | "error";
  model_id?: string;
  run_id?: string;
  elements_inserted?: number;
  dashboard_url?: string;
  error?: string;
}

// ── Handler ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 100;
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const DASHBOARD_URL = "https://etqblkgcvvyejdzvubin.supabase.co";

async function supabaseRequest(
  path: string,
  method: string,
  body?: unknown
): Promise<{ data: unknown[]; error?: string }> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Prefer": method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    return { data: [], error: `${res.status} ${res.statusText}: ${text}` };
  }
  try {
    const parsed = JSON.parse(text);
    return { data: Array.isArray(parsed) ? parsed : [parsed] };
  } catch {
    return { data: [] };
  }
}

export async function handlePushToBimDashboard(input: PushToBimDashboardInput): Promise<PushToBimDashboardOutput> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      status: "error",
      error: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the MCP server environment. Add them to ~/.claude/claude_desktop_config.json under mcpServers.workflow-builder.env",
    };
  }

  const now = new Date().toISOString();

  // ── 1. Upsert model ─────────────────────────────────────────────────────
  const modelPayload = {
    model_name: input.model_name,
    file_type: input.file_type,
    discipline: input.discipline,
    total_element_count: input.elements.length,
    level_count: input.level_count ?? Object.keys(
      input.elements.reduce((acc, e) => { if (e.level) acc[e.level] = 1; return acc; }, {} as Record<string, number>)
    ).length,
    sheet_count: input.sheet_count ?? null,
    view_count: input.view_count ?? null,
    warning_count: input.warning_count ?? null,
    last_extracted_at: now,
    extraction_status: "Success",
    approved: true,
    flagged: false,
    reviewer_notes: input.reviewer_notes ?? null,
  };

  // Check if model exists by name
  const existingRes = await supabaseRequest(
    `models?model_name=eq.${encodeURIComponent(input.model_name)}&select=id`,
    "GET"
  );

  let modelId: string;

  if (existingRes.data.length > 0) {
    // Update existing
    const existing = existingRes.data[0] as { id: string };
    modelId = existing.id;
    const updateRes = await supabaseRequest(
      `models?id=eq.${modelId}`,
      "PATCH",
      modelPayload
    );
    if (updateRes.error) {
      return { status: "error", error: `Failed to update model: ${updateRes.error}` };
    }
  } else {
    // Insert new
    const insertRes = await supabaseRequest("models", "POST", modelPayload);
    if (insertRes.error || insertRes.data.length === 0) {
      return { status: "error", error: `Failed to insert model: ${insertRes.error}` };
    }
    modelId = (insertRes.data[0] as { id: string }).id;
  }

  // ── 2. Insert run ────────────────────────────────────────────────────────
  const runRes = await supabaseRequest("runs", "POST", {
    model_id: modelId,
    triggered_by: "neeraj.yedekar@autodesk.com",
    started_at: now,
    completed_at: now,
    status: "Complete",
  });

  if (runRes.error || runRes.data.length === 0) {
    return { status: "error", error: `Failed to insert run: ${runRes.error}` };
  }
  const runId = (runRes.data[0] as { id: string }).id;

  // ── 3. Delete old elements if replacing ─────────────────────────────────
  if (input.replace_existing) {
    await supabaseRequest(`elements?model_id=eq.${modelId}`, "DELETE");
  }

  // ── 4. Insert elements in batches ────────────────────────────────────────
  let inserted = 0;
  for (let i = 0; i < input.elements.length; i += BATCH_SIZE) {
    const batch = input.elements.slice(i, i + BATCH_SIZE).map((e) => ({
      model_id: modelId,
      run_id: runId,
      element_id: e.element_id ?? null,
      category: e.category ?? null,
      family: e.family ?? null,
      family_type: e.family_type ?? null,
      level: e.level ?? null,
      phase_created: e.phase_created ?? null,
      comments: e.comments ?? null,
      mark: e.mark ?? null,
      area: e.area ?? null,
      volume: e.volume ?? null,
      length: e.length ?? null,
      structural: e.structural ?? null,
    }));

    const batchRes = await supabaseRequest("elements?select=id", "POST", batch);
    if (batchRes.error) {
      return { status: "error", error: `Batch insert failed at offset ${i}: ${batchRes.error}`, model_id: modelId, run_id: runId, elements_inserted: inserted };
    }
    inserted += batch.length;
  }

  return {
    status: "success",
    model_id: modelId,
    run_id: runId,
    elements_inserted: inserted,
    dashboard_url: DASHBOARD_URL,
  };
}
