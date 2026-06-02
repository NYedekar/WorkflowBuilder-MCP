// run_saved_workflow — deterministically replay a saved workflow with new inputs.
//
// Loads the frozen manifest by slug and runs it through the workflow-runner engine, which
// substitutes inputs, threads outputs between steps, and drives the EXISTING execute_workflow /
// get_workflow_status / get_result handlers. Async (DA) steps return a resumable run_handle —
// poll by calling this tool again with the same run_handle (just like get_workflow_status).
import { z } from "zod";
import { loadManifest } from "../lib/manifest-store.js";
import { runWorkflow } from "../lib/workflow-runner.js";
import { executeWorkflowSchema, handleExecuteWorkflow } from "./execute-workflow.js";
import { getWorkflowStatusSchema, handleGetWorkflowStatus } from "./get-workflow-status.js";
import { getResultSchema, handleGetResult } from "./get-result.js";
import { uploadFileSchema, handleUploadFile } from "./upload-file.js";
export const runSavedWorkflowSchema = z.object({
    slug: z.string().describe("The saved workflow's slug (from list_saved_workflows or save_workflow_as_skill)."),
    inputs: z
        .record(z.unknown())
        .optional()
        .default({})
        .describe("Per-run input values keyed by the manifest's input keys, e.g. { \"dwg_file\": \"~/Downloads/x.dwg\" }."),
    run_handle: z
        .record(z.unknown())
        .optional()
        .describe("Resume token returned by a previous pending call. Pass it back UNMODIFIED to advance the run. Omit on the first call."),
    skills_dir: z.string().optional().describe("Override the skills directory. Defaults to APS_SKILLS_DIR env or ~/.claude/skills."),
});
// Real executor surface — wires the runner to the existing tool handlers.
const deps = {
    async uploadFile(filePath) {
        const r = await handleUploadFile(uploadFileSchema.parse({ file_path: filePath }));
        return { status: r.status, oss_url: r.oss_url, error: r.error, REQUIRED_ACTION: r.REQUIRED_ACTION, mac_path_hint: r.mac_path_hint };
    },
    async execute(input) {
        const parsed = executeWorkflowSchema.parse({
            capability_id: input.capability_id,
            operation_id: input.operation_id,
            args: input.args,
            config: input.config,
            input_file_url: input.input_file_url,
        });
        const r = await handleExecuteWorkflow(parsed);
        return {
            status: r.status,
            workflow_handle: r.workflow_handle,
            outputOssUrls: r.outputOssUrls,
            outputOssUrl: r.outputOssUrl,
            response_oss_url: r.response_oss_url,
            reportUrl: r.reportUrl,
            error: r.error,
            hint: r.hint,
        };
    },
    async pollStatus(workflowHandle) {
        const r = await handleGetWorkflowStatus(getWorkflowStatusSchema.parse({ workflow_handle: workflowHandle }));
        return { status: r.status, outputOssUrls: r.outputOssUrls, reportUrl: r.reportUrl, error: r.error };
    },
    async getResult(ossUrl) {
        const r = await handleGetResult(getResultSchema.parse({ oss_url: ossUrl, read_content: true, max_chars: 2000 }));
        return {
            oss_url: ossUrl,
            detected_as: r.detected_as,
            size_bytes: r.size_bytes,
            preview: r.content,
            saved_to: r.saved_to,
            binary: r.binary,
        };
    },
};
export async function handleRunSavedWorkflow(input) {
    const loaded = loadManifest(input.slug, input.skills_dir);
    if (!loaded.ok)
        return { status: "error", error: loaded.error, hint: loaded.hint };
    return runWorkflow(loaded.manifest, input.inputs ?? {}, input.run_handle, deps);
}
