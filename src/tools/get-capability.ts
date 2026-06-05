import { z } from "zod";
import { searchCapabilities, findCapabilityById, type CapabilityRecord, type OperationRecord } from "../lib/registry-client.js";

// ── Verified ops (E2E tested) ─────────────────────────────────────────────
// Key format: "capabilityId/operationId". Add here as ops are confirmed working.
const VERIFIED_OPS = new Set([
  "autocad:AutoCADPlotToPDF/plot-all-sheets-to-pdf", // E2E confirmed (DWG→PDF smoke test)
  "revit:RevitExtractor/extract-all-parameters",
  "revit:RevitPDFExport/export-sheets-to-pdf",
  "revit:RevitPDFExport/export-views-to-pdf",        // same capability as sheets, not RevitViewsPDFExport
  "aps:md.jobs/start_translation_job",
  "aps:md.manifest/fetch_manifest",
  "aps:md.metadata/list_model_views",
  "aps:md.metadata/fetch_object_tree",
  "aps:md.metadata/query_specific_properties",
  "aps:md.thumbnail/fetch_thumbnail",
  "aps:dm.oss_buckets/create_bucket",
  "aps:dm.oss_buckets/list_buckets",
  "acc:hub-admin.projects/acc.admin_list_projects",  // actual operationId confirmed in registry
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
  displayName: string;
  callable: boolean;
  verified?: boolean;   // true = E2E tested and confirmed working
  // REST-specific
  httpMethod?: string;
  endpoint?: string;
  authScopes?: string[];
}

// Keywords that indicate a render/view/visualize intent — should always go to render_model, not get_capability.
const VIEWER_REDIRECT_RE =
  /\b(render|view|viewer|visuali[sz]e?|open.?in.?viewer|web.?viewer|svf2|translate.*(for|to).*(view|render)|see.?the.?model|open.?model|aps.?viewer|forge.?viewer)\b/i;

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

  // Hard redirect: render/view/visualize requests must use render_model, not this tool.
  // Manually constructing translate → manifest → viewer URL produces a hallucinated link that doesn't work.
  if (input.query && VIEWER_REDIRECT_RE.test(input.query)) {
    return {
      count: 0,
      capabilities: [],
      hint:
        "⛔ RENDER/VIEW REDIRECT: Do NOT use get_capability for viewer/render requests. " +
        "Call render_model(oss_url, mode='viewer') directly — it is the complete end-to-end solution: " +
        "handles SVF2 translation, builds the HTML, and AUTO-OPENS the full Autodesk Viewer in the browser. " +
        "There is no public APS Viewer URL to construct — any URL you generate manually will not work. " +
        "If the file is local, call upload_file first to get an oss_url, then call render_model.",
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
      displayName: o.displayName,
      callable: o.callable !== false,
      ...(VERIFIED_OPS.has(`${c.id}/${o.operationId}`) ? { verified: true } : {}),
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

  // Signpost: the ACC file-publish chain has a dedicated composite TOOL. If a
  // search surfaces the low-level DM/OSS primitives — or reads like an
  // "upload a file into a project folder" intent — steer to publish_to_acc_folder
  // so the model doesn't hand-drive create_storage→signeds3upload→create_item
  // (a known dead-end that 403s on the WIP bucket and looks like a missing capability).
  const PUBLISH_PRIMITIVES = new Set([
    "aps:dm.items_versions",
    "aps:dm.storage_commands",
    "aps:dm.oss_objects",
  ]);
  const surfacedPrimitive = summaries.some((s) => PUBLISH_PRIMITIVES.has(s.id));
  const q = (input.query ?? "").toLowerCase();
  const looksLikePublish =
    /\b(upload|publish|save|put|add|push|store|land)\b/.test(q) &&
    /\b(acc|bim ?360|docs|folder|project)\b/.test(q);
  const hint =
    surfacedPrimitive || looksLikePublish
      ? "To PUBLISH a file INTO an ACC/BIM360 project folder, use the publish_to_acc_folder TOOL — " +
        "one call runs create_storage → signed S3 upload → finalize → create_item, with find-or-create " +
        "folder resolution (folder_path + hub_id). Do NOT hand-drive these primitives via execute_workflow, " +
        "and do NOT use upload_file (it targets the app's own bucket, not project storage). " +
        "Call authenticate_aps_3lo first, and pass region (e.g. 'CAN') for non-US hubs."
      : undefined;

  return { count: summaries.length, capabilities: summaries, ...(hint ? { hint } : {}) };
}

