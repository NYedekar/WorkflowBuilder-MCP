import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getTwoLeggedToken } from "./auth/aps-token-client.js";
import { loadSecret } from "./auth/keychain.js";
import { setCachedToken } from "./auth/token-cache.js";
import { DEFAULT_SCOPES } from "./auth/credential-resolver.js";
import { getRateLimitWarning } from "./lib/rate-limiter.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_INSTRUCTIONS = readFileSync(join(__dirname, "instructions.md"), "utf-8");
import { createWorkflowSchema, handleCreateWorkflow, } from "./tools/create-workflow.js";
import { exportWorkflowSchema, handleExportWorkflow, } from "./tools/export-workflow.js";
import { authenticateApsSchema, handleAuthenticateAps, } from "./tools/authenticate-aps.js";
import { authenticateAps3LOSchema, handleAuthenticateAps3LO, } from "./tools/authenticate-aps-3lo.js";
import { getCapabilitySchema, handleGetCapability, } from "./tools/get-capability.js";
import { executeWorkflowSchema, handleExecuteWorkflow, } from "./tools/execute-workflow.js";
import { uploadFileSchema, handleUploadFile, } from "./tools/upload-file.js";
import { getResultSchema, handleGetResult, } from "./tools/get-result.js";
import { processFileSchema, handleProcessFile, } from "./tools/process-file.js";
import { getWorkflowStatusSchema, handleGetWorkflowStatus, } from "./tools/get-workflow-status.js";
import { getDownloadLinkSchema, handleGetDownloadLink, } from "./tools/get-download-link.js";
import { saveToMacSchema, handleSaveToMac, } from "./tools/save-to-mac.js";
import { renderModelSchema, handleRenderModel, } from "./tools/render-model.js";
import { recordTokenUsageSchema, handleRecordTokenUsage, SERVER_SESSION_ID, } from "./tools/record-token-usage.js";
import { getTokenUsageSchema, handleGetTokenUsage, } from "./tools/get-token-usage.js";
import { saveWorkflowAsSkillSchema, handleSaveWorkflowAsSkill, } from "./tools/save-workflow-as-skill.js";
import { listSavedWorkflowsSchema, handleListSavedWorkflows, } from "./tools/list-saved-workflows.js";
import { runSavedWorkflowSchema, handleRunSavedWorkflow, } from "./tools/run-saved-workflow.js";
import { buildPromptList, buildPromptMessages } from "./lib/prompt-builder.js";
import { exportSkillForClaudeSchema, handleExportSkillForClaude, } from "./tools/export-skill-zip.js";
import { offerSaveSkillButtonSchema, handleOfferSaveSkillButton, } from "./tools/offer-save-skill-button.js";
import { SAVE_SKILL_UI_URI, MCP_APP_MIME, SAVE_SKILL_UI_HTML } from "./lib/save-skill-ui.js";
// ─── Server setup ─────────────────────────────────────────────────────────
const server = new Server({
    name: "mcp-workflow-builder",
    version: "1.0.0",
}, {
    // `extensions` declares MCP Apps support (io.modelcontextprotocol/ui) for the interactive
    // "Save as skill" button. Cast: the SDK's ServerCapabilities type doesn't yet include the
    // extensions field, but it is passed through verbatim in the initialize response.
    capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } },
    },
    instructions: SERVER_INSTRUCTIONS,
});
// ─── Prompts: saved workflows surfaced as slash commands (any MCP host) ──────
server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: buildPromptList() };
});
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return buildPromptMessages(name, args);
});
// ─── Resources: the MCP Apps UI for the "Save as skill" button ───────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
            {
                uri: SAVE_SKILL_UI_URI,
                name: "Save workflow as skill (button)",
                mimeType: MCP_APP_MIME,
                _meta: { ui: { prefersBorder: true } },
            },
        ],
    };
});
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === SAVE_SKILL_UI_URI) {
        return { contents: [{ uri: SAVE_SKILL_UI_URI, mimeType: MCP_APP_MIME, text: SAVE_SKILL_UI_HTML }] };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
});
// ─── Tool list ─────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "authenticate_aps",
                description: "Verify APS credentials and cache a 2LO token. Call this automatically — no user confirmation needed. " +
                    "Reads APS_CLIENT_ID and APS_CLIENT_SECRET from the MCP process env (pre-configured on this Mac). " +
                    "Always call before process_file, execute_workflow, or upload_file.",
                inputSchema: zodToJsonSchema(authenticateApsSchema),
            },
            {
                name: "authenticate_aps_3lo",
                description: "Obtain a user-identity (3LO) token for ACC admin operations that reject 2LO client-credential tokens. " +
                    "Opens the Autodesk authorization page in your browser; stores refresh token in the OS keychain for auto-renewal. " +
                    "Call once before any ACC Admin or BIM 360 user-identity operation. No user confirmation needed.",
                inputSchema: zodToJsonSchema(authenticateAps3LOSchema),
            },
            {
                name: "get_capability",
                description: "CALL THIS FIRST when any Autodesk file extension or cloud service appears. " +
                    "Full format list and routing rules are in the MCP server instructions — see MANDATORY TRIGGER and ACC/DM tables. " +
                    "Searches 260+ capabilities (Engine-API + APS REST). Returns capability_id and operation_id. " +
                    "CALLABLE CHECK: callable=true → proceed. callable=false → rephrase query and retry. " +
                    "After all lookups: output a brief execution plan (task, capability_id, operation_id, pattern) before any upload or job submit.",
                inputSchema: zodToJsonSchema(getCapabilitySchema),
            },
            {
                name: "execute_workflow",
                description: "PREREQUISITE: capability_id MUST come from a get_capability() call in this session — NEVER use an ID from memory or training data. Unregistered IDs fail immediately. " +
                    "Execution plan (Step 3 in instructions) must be presented before the first call. " +
                    "Run a SINGLE APS capability operation: Engine-API (DA WorkItem submit → returns pending immediately → poll with get_workflow_status) " +
                    "or Platform-API (REST call → returns response inline). " +
                    "REST tip: pass all parameters in the single 'args' field — the tool auto-routes each key to path, query, or body. " +
                    "For REST operations requiring user identity (3LO_REQUIRED error), call authenticate_aps_3lo first.",
                inputSchema: zodToJsonSchema(executeWorkflowSchema),
            },
            {
                name: "create_workflow",
                description: "Use ONLY when intents on the same file are SEQUENTIALLY DEPENDENT — the output of step A is the input to step B. " +
                    "Uploads the file once and builds an execution DAG. " +
                    "For INDEPENDENT intents on the same file (both just read the raw file), use upload_file → parallel execute_workflow instead — it is faster. " +
                    "Do NOT use if intents are independent of each other.",
                inputSchema: zodToJsonSchema(createWorkflowSchema),
            },
            {
                name: "process_file",
                description: "BEFORE CALLING: count how many intents target this exact file_path. " +
                    "If 2 or more intents target the same file_path → STOP. Do NOT call process_file. " +
                    "Call upload_file(file_path) once, then execute_workflow in parallel for each intent (CASE B). " +
                    "process_file re-uploads the file on every call — calling it twice on the same file wastes bandwidth and time. " +
                    "ONLY call process_file when exactly ONE intent targets this file_path. " +
                    "Process a local Autodesk file on this Mac. The MCP server runs as a LOCAL process and reads " +
                    "Mac filesystem paths directly (~/Downloads/, /Users/..., OneDrive paths). " +
                    "DO NOT say you cannot access a local path — pass it straight to this tool. " +
                    "Fast path: auto-selects capability, uploads to APS, runs the job, returns results. " +
                    "On pending response: immediately chains to get_workflow_status → get_result → get_download_link — " +
                    "no user confirmation needed for any step.",
                inputSchema: zodToJsonSchema(processFileSchema),
            },
            {
                name: "upload_file",
                description: "PREREQUISITE: get_capability must have been called for all intents, and the execution plan (Step 3) presented, before calling this. " +
                    "Upload a file to APS OSS. Pass file_path for a local Mac file, or file_url for an HTTPS URL " +
                    "(e.g. OneDrive 'Anyone with the link' sharing URL or any public HTTPS file URL). " +
                    "Returns oss:// URL for use with execute_workflow.",
                inputSchema: zodToJsonSchema(uploadFileSchema),
            },
            {
                name: "get_result",
                description: "Fetch output file content from APS OSS. CALL THIS AUTOMATICALLY — no user confirmation needed — " +
                    "whenever get_workflow_status returns status=success with outputOssUrls. " +
                    "Call once per oss:// URL in outputOssUrls. " +
                    "Binary outputs (PDF, DWG, ZIP) are auto-saved to ~/Downloads — no save_to param needed. " +
                    "Large text outputs (CSV, JSON > 10K chars) are also auto-saved to ~/Downloads; a 500-char preview is returned. " +
                    "Pass read_content=true to return the full text inline instead. " +
                    "TOKEN TRACKING: on the final get_result call, pass model=<your model ID>, " +
                    "estimated_input_tokens=<total session estimate>, estimated_output_tokens=<total session estimate> " +
                    "to auto-record token usage inline. The response returns summary_line — output it verbatim as the LAST line of your response.",
                inputSchema: zodToJsonSchema(getResultSchema),
            },
            {
                name: "get_workflow_status",
                description: "Poll the status of one or more running Autodesk DA jobs. CALL THIS AUTOMATICALLY — no user confirmation needed. " +
                    "MULTI-JOB: pass workflow_handle as an ARRAY to poll all jobs in parallel in one call (wall time = slowest, not sum). " +
                    "When status=pending: IMMEDIATELY call again with the same workflow_handle — do not ask the user, do not wait. " +
                    "DO NOT output any text between polls — no explanations, no 'retrying', no timeout notes. Just call again silently. " +
                    "Each call polls for up to 25s then returns — this is fixed and correct, do NOT try to change it. " +
                    "Revit and AutoCAD jobs take 3–8 minutes — keep polling until overall_status=success or failed. " +
                    "When done: STOP polling and call get_result on each outputOssUrl in the next_action chain.",
                inputSchema: zodToJsonSchema(getWorkflowStatusSchema),
            },
            {
                name: "get_download_link",
                description: "Generate a clickable HTTPS download link for any file in APS OSS. " +
                    "TOKEN TRACKING: if this is the final step of a workflow (no get_result calls follow), " +
                    "call record_token_usage immediately after with model, estimated tokens, and capability_id + operation_id.",
                inputSchema: zodToJsonSchema(getDownloadLinkSchema),
            },
            {
                name: "export_workflow",
                description: "Serialize a workflow DAG to JSON or YAML, optionally saving to a file.",
                inputSchema: zodToJsonSchema(exportWorkflowSchema),
            },
            {
                name: "save_to_mac",
                description: "Save text content (JSON, CSV, Markdown, plain text) directly to the Mac filesystem.",
                inputSchema: zodToJsonSchema(saveToMacSchema),
            },
            {
                name: "render_model",
                description: "Render an APS model visually — either as an interactive 3D viewer or as a thumbnail image.",
                inputSchema: zodToJsonSchema(renderModelSchema),
            },
            {
                name: "record_token_usage",
                description: "Record AI token usage for this session to a persistent local log. " +
                    "REQUIRED after multi-job sessions — call this after the last get_result, then output summary_line verbatim as the LAST line of your response. " +
                    "(Single-job: auto-called by get_result when model + token params are passed.) " +
                    `Current session ID: ${SERVER_SESSION_ID}. `,
                inputSchema: zodToJsonSchema(recordTokenUsageSchema),
            },
            {
                name: "get_token_usage",
                description: "Query the token-usage log written by record_token_usage. " +
                    "Returns totals, per-model and per-workflow breakdowns, and recent records. " +
                    "Filter by date range, session_id, workflow_id, or model.",
                inputSchema: zodToJsonSchema(getTokenUsageSchema),
            },
            {
                name: "save_workflow_as_skill",
                description: "Freeze a workflow you JUST ran into a reusable Claude skill the user can invoke as /<slug> with different inputs each time. " +
                    "Offer this AFTER a successful multi-step run when the user says 'save this', 'make this a skill', 'I'll do this again', or the flow is clearly repeatable. " +
                    "Pass the recipe from your context: name, intent, the ordered steps (capability_id + operation_id + fixed args), " +
                    "and inputs[] for the values that vary per run (reference them in step args as {{key}}). " +
                    "The tool validates every capability_id/operation_id against the registry, derives 2LO/3LO auth, rejects baked-in secrets, " +
                    "and writes SKILL.md + workflow.json into the skills directory. NEVER put tokens or secrets in step args.",
                inputSchema: zodToJsonSchema(saveWorkflowAsSkillSchema),
            },
            {
                name: "list_saved_workflows",
                description: "List the workflows the user has saved as skills (via save_workflow_as_skill). " +
                    "Returns each one's slug, name, intent, required/optional inputs, step count, and auth mode. " +
                    "Call ONLY when the user explicitly asks to see/discover their saved workflows, or when you need " +
                    "a slug to run one and it wasn't given. DO NOT call it as a default first step — it is not part of " +
                    "executing a file task or saving a skill. For a 'do X' request, go straight to get_capability.",
                inputSchema: zodToJsonSchema(listSavedWorkflowsSchema),
            },
            {
                name: "run_saved_workflow",
                description: "Deterministically replay a saved workflow with new inputs — no need to re-plan the steps. " +
                    "Pass slug + inputs (keyed by the manifest's input keys). The engine validates inputs, uploads file inputs once, " +
                    "substitutes them into the frozen steps, threads outputs between steps, and runs each via execute_workflow. " +
                    "ASYNC: when a Design Automation step is still running, this returns status=pending with a run_handle — " +
                    "call run_saved_workflow again with the SAME run_handle (unmodified) to advance, exactly like get_workflow_status. " +
                    "On 3lo_required: call authenticate_aps_3lo then re-invoke with the run_handle.",
                inputSchema: zodToJsonSchema(runSavedWorkflowSchema),
            },
            {
                name: "export_skill_for_claude",
                description: "Package a saved workflow-skill into a claude.ai-ready ZIP so it can be added to the user's " +
                    "Claude (Desktop/web) Skills panel. Use when the user wants a saved workflow to appear as a " +
                    "Skill in Claude Desktop/claude.ai. NOTE: there is NO API to auto-upload personal skills to " +
                    "claude.ai — this produces a correctly structured ZIP (skill folder as root); the user uploads it " +
                    "via claude.ai/customize/skills → + → Create skill, after which it syncs to the Desktop Skills panel.",
                inputSchema: zodToJsonSchema(exportSkillForClaudeSchema),
            },
            {
                name: "offer_save_skill_button",
                description: "EXPERIMENTAL (MCP Apps): render an interactive 'Save as skill' button in the conversation. " +
                    "Use on hosts that support MCP Apps (io.modelcontextprotocol/ui, e.g. Claude Desktop) when offering to save " +
                    "a just-run workflow. Pass the same recipe you'd pass to save_workflow_as_skill (name, intent, inputs, steps). " +
                    "The button calls save_workflow_as_skill on click. If the host doesn't render it, fall back to save_workflow_as_skill directly.",
                inputSchema: zodToJsonSchema(offerSaveSkillButtonSchema),
                _meta: { ui: { resourceUri: SAVE_SKILL_UI_URI, visibility: ["model", "app"] } },
            },
        ],
    };
});
// ─── Tool dispatch ─────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        let result;
        switch (name) {
            case "authenticate_aps":
                result = await handleAuthenticateAps(authenticateApsSchema.parse(args));
                break;
            case "authenticate_aps_3lo":
                result = await handleAuthenticateAps3LO(authenticateAps3LOSchema.parse(args ?? {}));
                break;
            case "get_capability":
                result = await handleGetCapability(getCapabilitySchema.parse(args));
                break;
            case "execute_workflow":
                result = await handleExecuteWorkflow(executeWorkflowSchema.parse(args));
                break;
            case "create_workflow":
                result = await handleCreateWorkflow(createWorkflowSchema.parse(args));
                break;
            case "process_file":
                result = await handleProcessFile(processFileSchema.parse(args));
                break;
            case "upload_file":
                result = await handleUploadFile(uploadFileSchema.parse(args));
                break;
            case "get_result":
                result = await handleGetResult(getResultSchema.parse(args));
                break;
            case "get_workflow_status":
                result = await handleGetWorkflowStatus(getWorkflowStatusSchema.parse(args));
                break;
            case "get_download_link":
                result = await handleGetDownloadLink(getDownloadLinkSchema.parse(args));
                break;
            case "export_workflow":
                result = await handleExportWorkflow(exportWorkflowSchema.parse(args));
                break;
            case "save_to_mac":
                result = await handleSaveToMac(saveToMacSchema.parse(args));
                break;
            case "render_model":
                result = await handleRenderModel(renderModelSchema.parse(args));
                break;
            case "record_token_usage":
                result = await handleRecordTokenUsage(recordTokenUsageSchema.parse(args));
                break;
            case "get_token_usage":
                result = await handleGetTokenUsage(getTokenUsageSchema.parse(args));
                break;
            case "save_workflow_as_skill":
                result = await handleSaveWorkflowAsSkill(saveWorkflowAsSkillSchema.parse(args));
                break;
            case "list_saved_workflows":
                result = await handleListSavedWorkflows(listSavedWorkflowsSchema.parse(args ?? {}));
                break;
            case "run_saved_workflow":
                result = await handleRunSavedWorkflow(runSavedWorkflowSchema.parse(args));
                break;
            case "export_skill_for_claude":
                result = await handleExportSkillForClaude(exportSkillForClaudeSchema.parse(args));
                break;
            case "offer_save_skill_button":
                // Return the CallToolResult directly so structuredContent reaches the MCP Apps iframe
                // (the generic wrapper below would otherwise stringify everything into a text block).
                return handleOfferSaveSkillButton(offerSaveSkillButtonSchema.parse(args));
            default:
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
                    isError: true,
                };
        }
        // Inject rate limit warning when approaching APS 150 RPM limit
        const rateLimitWarning = getRateLimitWarning();
        const responsePayload = rateLimitWarning && result && typeof result === "object"
            ? { ...result, _rate_limit_warning: rateLimitWarning }
            : result;
        return {
            content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: String(err) }),
                },
            ],
            isError: true,
        };
    }
});
// ─── Startup credential pre-flight ────────────────────────────────────────
async function preflight() {
    const clientId = process.env.APS_CLIENT_ID?.trim();
    if (!clientId) {
        process.stderr.write("[mcp-workflow-builder] WARNING: APS_CLIENT_ID not set — authenticate_aps will fail. " +
            "Configure credentials in Claude config and restart.\n");
        return;
    }
    const clientSecret = loadSecret(clientId) ?? process.env.APS_CLIENT_SECRET?.trim() ?? null;
    if (!clientSecret) {
        process.stderr.write("[mcp-workflow-builder] WARNING: APS client secret not found in keychain or env — " +
            "authenticate_aps will fail. Run: cd <mcp-workflow-builder dir> && npm run setup\n");
        return;
    }
    try {
        const token = await getTwoLeggedToken(clientId, clientSecret, DEFAULT_SCOPES);
        const cacheKey = `2lo:${clientId}:${DEFAULT_SCOPES.slice().sort().join(",")}`;
        setCachedToken(cacheKey, token.access_token, token.expires_in);
        process.stderr.write(`[mcp-workflow-builder] APS credentials OK — token cached (expires in ${token.expires_in}s).\n`);
    }
    catch (err) {
        process.stderr.write(`[mcp-workflow-builder] WARNING: APS auth preflight failed: ${err}. ` +
            "Check credentials at aps.autodesk.com/myapps.\n");
    }
}
// ─── Start ────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Fire-and-forget: warms token cache; errors surface to stderr only, never block startup.
    preflight().catch(() => { });
}
main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
});
