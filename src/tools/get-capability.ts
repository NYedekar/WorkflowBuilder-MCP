import { z } from "zod";
import { searchCapabilities, findCapabilityById, type CapabilityRecord, type OperationRecord } from "../lib/registry-client.js";

// ── Verified ops (E2E tested) ─────────────────────────────────────────────
// Key format: "capabilityId/operationId". Add here as ops are confirmed working.
const VERIFIED_OPS = new Set([
  "autocad:AutoCADPlotToPDF/plot-to-pdf",
  "revit:RevitExtractor/extract-all-parameters",
  "revit:RevitPDFExport/export-sheets-to-pdf",
  "revit:RevitViewsPDFExport/export-views-to-pdf",
  "aps:md.jobs/start_translation_job",
  "aps:md.manifest/fetch_manifest",
  "aps:md.metadata/list_model_views",
  "aps:md.metadata/fetch_object_tree",
  "aps:md.metadata/query_specific_properties",
  "aps:md.thumbnail/fetch_thumbnail",
  "aps:dm.oss_buckets/create_bucket",
  "aps:dm.oss_buckets/list_buckets",
  "acc:hub-admin.projects/list_projects",
]);

export const getCapabilitySchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Natural language or keyword search across capability names, descriptions, and operations. " +
        "Examples: 'extract room data', 'export IFC', 'validate model', 'translation job'."
    ),
  capability_id: z
    .string()
    .optional()
    .describe(
      "Exact capability ID or alias. Examples: 'RevitElementDataExtraction', " +
        "'revit:RevitModelHealthCheck', 'aps:dm.oss_objects'."
    ),
  operation_id: z
    .string()
    .optional()
    .describe(
      "Find by operation ID or globalOperationId. Examples: 'extract-room-data', " +
        "'revit.extract-room-data', 'get_signed_s3_upload'."
    ),
  risk: z
    .enum(["SAFE", "REVIEW", "BLOCKED"])
    .optional()
    .describe("Filter by risk level. SAFE = read-only, REVIEW = write/modify, BLOCKED = not callable."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("Max results to return (default 5, max 20)."),
});

export type GetCapabilityInput = z.infer<typeof getCapabilitySchema>;

export interface GetCapabilityResult {
  count: number;
  capabilities: CapabilitySummary[];
  hint?: string;
}

interface CapabilitySummary {
  id: string;
  alias: string;
  domain: string;
  engine: string;
  ioShape: string;
  description?: string;
  operations: OperationSummary[];
}

interface OperationSummary {
  operationId: string;
  callable: boolean;
  verified?: boolean;           // true = E2E tested and confirmed working
  estimated_tokens?: string;    // rough token cost hint for execution plan
  // REST-specific
  httpMethod?: string;
  endpoint?: string;
  authScopes?: string[];
}

export async function handleGetCapability(
  input: GetCapabilityInput
): Promise<GetCapabilityResult> {
  // If no filters at all, return a helpful message
  if (!input.query && !input.capability_id && !input.operation_id && !input.risk) {
    return {
      count: 0,
      capabilities: [],
      hint: "Provide at least one filter: query, capability_id, operation_id, or risk. Example: get_capability({ query: 'dwg translate' })",
    };
  }

  let caps: CapabilityRecord[];

  // Exact lookup takes priority
  if (input.capability_id && !input.query) {
    const exact = findCapabilityById(input.capability_id);
    caps = exact ? [exact] : [];
  } else {
    caps = searchCapabilities({
      query: input.query,
      capabilityId: input.capability_id,
      operationId: input.operation_id,
      risk: input.risk,
      limit: input.limit,
    });
  }

  const summaries: CapabilitySummary[] = caps.map((c) => {
    const isEngineApi = c.domain === "Engine-APIs";
    // For search results cap ops at 10; for exact ID lookups return all
    const isExact = !!input.capability_id && !input.query;
    const opsToShow = isExact ? c.operations : c.operations.slice(0, 10);

    const opSummaries: OperationSummary[] = opsToShow.map((o) => ({
      operationId: o.operationId,
      callable: o.callable !== false,
      ...(VERIFIED_OPS.has(`${c.id}/${o.operationId}`) ? { verified: true } : {}),
      estimated_tokens: estimateTokens(o, isEngineApi),
      httpMethod: o.httpMethod,
      endpoint: o.endpoint,
      ...(o.authScopes?.length ? { authScopes: o.authScopes } : {}),
    }));

    return {
      id: c.id,
      alias: c.alias,
      domain: c.domain,
      engine: c.engine,
      ioShape: c.ioShape,
      description: c.description ? c.description.slice(0, 160) : undefined,
      operations: opSummaries,
    };
  });

  return { count: summaries.length, capabilities: summaries };
}

// ── Token estimation ──────────────────────────────────────────────────────
// Rough per-operation estimate shown in execution plan briefing (±40% accuracy).
// Engine-API jobs dominate: N polls × ~200t + result. REST calls are one round-trip.

function estimateTokens(op: OperationRecord, isEngineApi: boolean): string {
  if (isEngineApi) {
    // Revit: 25–40 polls × 200t + 1K result ≈ 6K–9K
    // AutoCAD: 3–8 polls × 200t + 500t ≈ 1K–2K
    const engine = (op.engine ?? "").toLowerCase();
    if (engine.includes("revit")) return "~6,000–9,000t (includes polling)";
    if (engine.includes("autocad")) return "~1,000–2,500t (includes polling)";
    return "~2,000–8,000t (includes polling)";
  }
  // REST: single call — cost is mostly instructions overhead + response size
  return "~300–1,000t (single call)";
}
