import { z } from "zod";
import { readPending, findLatestPendingSession, completePending, } from "../lib/viewer-server.js";
import { handleExecuteWorkflow } from "./execute-workflow.js";
import { handleRenderModel } from "./render-model.js";
// ── Schema ────────────────────────────────────────────────────────────────
export const applyViewerUpdatesSchema = z.object({
    session_id: z
        .string()
        .optional()
        .describe("Session ID shown in the viewer's 'Changes Saved' dialog. " +
        "If omitted, the most recently submitted pending session is used."),
    output_rvt_oss_url: z
        .string()
        .optional()
        .describe("Provide this ONLY on the second call, after get_workflow_status reports success. " +
        "Pass the result.rvt OSS URL from outputOssUrls — the tool will re-render it and " +
        "update the viewer's status so the browser auto-refreshes."),
});
// ── Handler ───────────────────────────────────────────────────────────────
export async function handleApplyViewerUpdates(input) {
    const sessionId = input.session_id ?? findLatestPendingSession();
    if (!sessionId) {
        return {
            status: "error",
            error: "No pending viewer updates found. Open the viewer, edit some properties, and click 'Apply to Model' first.",
        };
    }
    const pending = readPending(sessionId);
    if (!pending) {
        return {
            status: "error",
            error: `No pending data for session '${sessionId}'. The session may have expired or never been submitted.`,
        };
    }
    // ── Phase 2: translate updated RVT → open new viewer ────────────────
    // Called once after DA succeeds, then re-called each time until translation is done.
    // render_model returns "pending" while SVF2 translation is in progress; we loop back
    // until it returns "success" (which is when it auto-opens the browser and writes the file).
    if (input.output_rvt_oss_url) {
        completePending(sessionId, { status: "processing" });
        try {
            const rvtExtensions = [".rvt", ".rfa", ".rte", ".rft"];
            const hasRvtExt = rvtExtensions.some(ext => input.output_rvt_oss_url.toLowerCase().endsWith(ext));
            const renderResult = await handleRenderModel({
                oss_url: input.output_rvt_oss_url,
                mode: "viewer",
                region: "US",
                force_retranslate: false, // false: start translation on first call, check status on retries
                root_filename: hasRvtExt ? undefined : "model.rvt",
            });
            if (renderResult.status === "success") {
                const filePath = renderResult.file_path;
                completePending(sessionId, { status: "done", new_file_path: filePath });
                return {
                    status: "success",
                    session_id: sessionId,
                    changes_applied: pending.changes.length,
                    new_viewer_file: filePath,
                    message: `Model updated! ${pending.changes.length} parameter change(s) applied. ` +
                        `New viewer opened at ${filePath}. ` +
                        "The original viewer browser tab will auto-refresh within ~10 seconds.",
                };
            }
            if (renderResult.status === "pending") {
                // SVF2 translation still running — tell Claude to retry this call in ~60s
                return {
                    status: "translating",
                    session_id: sessionId,
                    output_rvt_oss_url: input.output_rvt_oss_url,
                    message: renderResult.message ?? "Translation in progress.",
                    next_action: `SVF2 translation is still running. Wait ~60 seconds then call ` +
                        `apply_viewer_updates(session_id='${sessionId}', output_rvt_oss_url='${input.output_rvt_oss_url}') ` +
                        `again to check progress. Repeat until status=success.`,
                };
            }
            // Error from render_model
            const errMsg = renderResult.error ?? "render_model returned an error";
            completePending(sessionId, { status: "failed", error: errMsg });
            return { status: "error", error: errMsg };
        }
        catch (err) {
            completePending(sessionId, { status: "failed", error: String(err) });
            return { status: "error", error: `Re-render failed: ${String(err)}` };
        }
    }
    // ── Phase 1: submit DA job ────────────────────────────────────────────
    if (!pending.changes.length) {
        return { status: "error", error: "Pending session has no changes to apply." };
    }
    completePending(sessionId, { status: "processing" });
    const execResult = await handleExecuteWorkflow({
        capability_id: "revit:RevitParameterUpdater",
        operation_id: "update-element-parameters",
        input_file_url: pending.oss_url,
        path_params: {},
        query_params: {},
        config: {
            inputMode: "text_input",
            changes: pending.changes,
        },
        inline_args: {},
        output_bucket_policy: "transient",
    });
    if (execResult.status !== "pending") {
        completePending(sessionId, { status: "failed", error: execResult.error ?? "DA submission failed" });
        return {
            status: "error",
            error: `DA job submission failed: ${execResult.error ?? "unknown error"}`,
            hint: execResult.hint,
        };
    }
    return {
        status: "pending",
        session_id: sessionId,
        changes_count: pending.changes.length,
        input_rvt_oss_url: pending.oss_url,
        workflow_handle: execResult.workflow_handle,
        workItemId: execResult.workItemId,
        next_action: "1. Poll get_workflow_status(workflow_handle) until overall_status=success. " +
            "2. Identify the result.rvt entry in outputOssUrls (first .rvt URL). " +
            `3. Call apply_viewer_updates(session_id='${sessionId}', output_rvt_oss_url=<result.rvt url>) ` +
            "to re-render the updated model and notify the viewer.",
    };
}
