import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import { pollWorkItem, finalizeS3Upload } from "../lib/da-client.js";
// ── Schema ────────────────────────────────────────────────────────────────
const s3FinalizeEntrySchema = z.object({
    bucketKey: z.string(),
    objectKey: z.string(),
    uploadKey: z.string(),
    ossUrl: z.string(),
});
const workflowHandleSchema = z.object({
    type: z.enum(["da_workitem"]),
    workItemId: z.string(),
    outputOssUrls: z.array(z.string()),
    s3FinalizeQueue: z.array(s3FinalizeEntrySchema).optional().default([]),
});
export const getWorkflowStatusSchema = z.object({
    workflow_handle: workflowHandleSchema.describe("The workflow_handle object returned by execute_workflow or a previous get_workflow_status call " +
        "when status was 'pending'. Pass it back exactly as received — do not modify it."),
    timeout_ms: z
        .number()
        .int()
        .min(5_000)
        .max(55_000)
        .optional()
        .default(50_000)
        .describe("Max ms to poll in this call. Default 50 000 (safe under 60s MCP transport limit). " +
        "If the job is still running at timeout, status='pending' is returned — call again with the same workflow_handle."),
});
// ── Handler ───────────────────────────────────────────────────────────────
const DA_SCOPES = [
    "code:all",
    "data:read",
    "data:write",
    "data:create",
    "bucket:create",
    "bucket:read",
    "bucket:update",
];
export async function handleGetWorkflowStatus(input) {
    const t0 = Date.now();
    const handle = input.workflow_handle;
    // ── Auth ──────────────────────────────────────────────────────────────────
    let token;
    try {
        const cred = await resolveCredential(DA_SCOPES);
        token = cred.access_token;
    }
    catch (err) {
        return {
            status: "error",
            workItemId: handle.workItemId,
            error: `APS auth failed: ${String(err)}`,
            hint: "Run authenticate_aps first.",
        };
    }
    // ── Dispatch by handle type ───────────────────────────────────────────────
    if (handle.type === "da_workitem") {
        return pollDaWorkItem(token, handle, input.timeout_ms, t0);
    }
    return {
        status: "error",
        error: `Unknown workflow_handle type: '${handle.type}'. Only 'da_workitem' is supported currently.`,
    };
}
// ── DA WorkItem poller ────────────────────────────────────────────────────
async function pollDaWorkItem(token, handle, timeoutMs, t0) {
    let finalItem;
    let timedOut = false;
    let pollError;
    try {
        finalItem = await pollWorkItem(token, handle.workItemId, timeoutMs);
    }
    catch (err) {
        const msg = String(err);
        if (msg.toLowerCase().includes("timed out")) {
            timedOut = true;
        }
        else {
            pollError = msg;
        }
    }
    const durationMs = Date.now() - t0;
    // ── Still running — return pending with same handle ───────────────────
    if (timedOut) {
        return {
            status: "pending",
            workflow_handle: handle,
            workItemId: handle.workItemId,
            durationMs,
            hint: "WorkItem is still running. Call get_workflow_status again with the same workflow_handle.",
        };
    }
    if (pollError) {
        return {
            status: "error",
            workItemId: handle.workItemId,
            error: pollError,
        };
    }
    // ── Job done — finalize S3 uploads ────────────────────────────────────
    const queue = handle.s3FinalizeQueue ?? [];
    for (const entry of queue) {
        try {
            await finalizeS3Upload(token, entry.bucketKey, entry.objectKey, entry.uploadKey);
        }
        catch {
            // Non-fatal: already finalized or object missing
        }
    }
    // ── Map DA status to our status ───────────────────────────────────────
    const daStatus = finalItem.status;
    if (daStatus === "success") {
        return {
            status: "success",
            workItemId: handle.workItemId,
            outputOssUrls: handle.outputOssUrls,
            reportUrl: finalItem.reportUrl,
            durationMs,
            hint: handle.outputOssUrls.length > 1
                ? `${handle.outputOssUrls.length} output files. Call get_result on each outputOssUrls entry.`
                : "Call get_result with outputOssUrls[0] to read the output.",
        };
    }
    if (daStatus === "cancelled") {
        return {
            status: "cancelled",
            workItemId: handle.workItemId,
            reportUrl: finalItem.reportUrl,
            durationMs,
            error: "WorkItem was cancelled.",
        };
    }
    return {
        status: "failed",
        workItemId: handle.workItemId,
        reportUrl: finalItem.reportUrl,
        durationMs,
        error: `WorkItem finished with status '${daStatus}'.`,
        hint: `Inspect the execution report: ${finalItem.reportUrl ?? "(no report URL)"}`,
    };
}
