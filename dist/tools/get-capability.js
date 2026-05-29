import { z } from "zod";
import { searchCapabilities, findCapabilityById } from "../lib/registry-client.js";
// ── Verified ops (E2E tested) ─────────────────────────────────────────────
// Key format: "capabilityId/operationId". Add here as ops are confirmed working.
const VERIFIED_OPS = new Set([
    "autocad:AutoCADPlotToPDF/plot-all-sheets-to-pdf", // E2E confirmed (DWG→PDF smoke test)
    "revit:RevitExtractor/extract-all-parameters",
    "revit:RevitPDFExport/export-sheets-to-pdf",
    "revit:RevitPDFExport/export-views-to-pdf", // same capability as sheets, not RevitViewsPDFExport
    "aps:md.jobs/start_translation_job",
    "aps:md.manifest/fetch_manifest",
    "aps:md.metadata/list_model_views",
    "aps:md.metadata/fetch_object_tree",
    "aps:md.metadata/query_specific_properties",
    "aps:md.thumbnail/fetch_thumbnail",
    "aps:dm.oss_buckets/create_bucket",
    "aps:dm.oss_buckets/list_buckets",
    "acc:hub-admin.projects/acc.admin_list_projects", // actual operationId confirmed in registry
]);
export const getCapabilitySchema = z.object({
    query: z
        .string()
        .optional()
        .describe("Natural language or keyword search across capability names, descriptions, and operations. " +
        "Examples: 'extract room data', 'export IFC', 'validate model', 'translation job'."),
    capability_id: z
        .string()
        .optional()
        .describe("Exact capability ID or alias. Examples: 'RevitElementDataExtraction', " +
        "'revit:RevitModelHealthCheck', 'aps:dm.oss_objects'."),
    operation_id: z
        .string()
        .optional()
        .describe("Find by operation ID or globalOperationId. Examples: 'extract-room-data', " +
        "'revit.extract-room-data', 'get_signed_s3_upload'."),
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
export async function handleGetCapability(input) {
    // If no filters at all, return a helpful message
    if (!input.query && !input.capability_id && !input.operation_id && !input.risk) {
        return {
            count: 0,
            capabilities: [],
            hint: "Provide at least one filter: query, capability_id, operation_id, or risk. Example: get_capability({ query: 'dwg translate' })",
        };
    }
    let caps;
    // Exact lookup takes priority
    if (input.capability_id && !input.query) {
        const exact = findCapabilityById(input.capability_id);
        caps = exact ? [exact] : [];
    }
    else {
        caps = searchCapabilities({
            query: input.query,
            capabilityId: input.capability_id,
            operationId: input.operation_id,
            risk: input.risk,
            limit: input.limit,
        });
    }
    const summaries = caps.map((c) => {
        const isEngineApi = c.domain === "Engine-APIs";
        // For search results cap ops at 10; for exact ID lookups return all
        const isExact = !!input.capability_id && !input.query;
        const opsToShow = isExact ? c.operations : c.operations.slice(0, 10);
        const opSummaries = opsToShow.map((o) => ({
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
    return { count: summaries.length, capabilities: summaries };
}
