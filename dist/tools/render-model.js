import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { resolveCredential } from "../auth/credential-resolver.js";
import { registerViewer } from "../lib/viewer-server.js";
import { handleRecordTokenUsage } from "./record-token-usage.js";
const execAsync = promisify(exec);
const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";
// Mirrors get_result's token-tracking + save-as-skill flow so render_model behaves consistently.
const TOKEN_REMINDER = "TOKEN TRACKING: call record_token_usage(model=<your model ID>, input_tokens=<total session estimate>, " +
    "output_tokens=<total session estimate>), then output the returned summary_line verbatim as the LAST line of your response.";
const SAVE_SKILL_OFFER = "Then — if rendering models like this is something the user might do again, and this was NOT launched from a " +
    'saved workflow (run_saved_workflow) — ASK: "Want me to save this as a reusable skill you can re-run on any file?" ' +
    "If yes, call save_workflow_as_skill with the exact steps you just ran (upload_file → render_model).";
async function tryAutoRecordTokens(model, inTok, outTok) {
    if (!model || !inTok || !outTok)
        return undefined;
    try {
        return (await handleRecordTokenUsage({ model, input_tokens: inTok, output_tokens: outTok })).summary_line;
    }
    catch {
        return undefined;
    }
}
// M1: pinned viewer version — update deliberately after testing; never use 7.* wildcard
const VIEWER_VERSION = "7.108.0";
// ── Schema ────────────────────────────────────────────────────────────────
export const renderModelSchema = z.object({
    oss_url: z
        .string()
        .regex(/^oss:\/\/[^/]+\/.+/, "Must be an oss:// URL in the form oss://bucketKey/objectKey") // M2
        .describe("The oss:// URL of the model file (e.g. oss://bucket/model.rvt). " +
        "The model must already be in APS OSS — upload it with upload_file first."),
    mode: z
        .enum(["viewer", "thumbnail"])
        .optional()
        .default("viewer")
        .describe("'viewer' (default): auto-translates to SVF2 if needed; returns a rendered preview image " +
        "(shown in chat) plus viewer_url — a localhost link Claude posts in chat that opens the " +
        "full interactive APS Viewer in the browser. " +
        "'thumbnail': returns just the rendered preview image inline in chat."),
    region: z
        .enum(["US", "EMEA"])
        .optional()
        .default("US")
        .describe("Region for storing SVF2 derivatives. Default: 'US'. " +
        "Use 'EMEA' for EU data-residency compliance."), // H4
    force_retranslate: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force re-translation even if SVF2 derivatives already exist. " +
        "Deletes the existing manifest and restarts from scratch. " +
        "Use only if a previous translation produced a corrupt or incomplete result."), // C4
    model: z
        .string()
        .optional()
        .describe("Your model ID (e.g. 'claude-sonnet-4-6'). Provide with estimated_input_tokens and " +
        "estimated_output_tokens to auto-record token usage inline (like get_result) — returns a summary_line."),
    estimated_input_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Estimated total session input tokens. Provide on the final (success) render to auto-record usage."),
    estimated_output_tokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Estimated total session output tokens. Provide on the final (success) render to auto-record usage."),
});
// ── Helpers ───────────────────────────────────────────────────────────────
function ossUrlToUrn(ossUrl) {
    const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
    const resourceUrn = `urn:adsk.objects:os.object:${withoutScheme}`;
    return Buffer.from(resourceUrn).toString("base64url"); // L3: native Node 18+ base64url
}
// L1: default 30s (was 15s — manifest on large models can be hundreds of KB)
async function apiFetch(url, options, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
async function getManifestStatus(token, urn) {
    // H1: URN is base64url — chars [A-Za-z0-9_-] are URL-safe; no encodeURIComponent needed
    const res = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404)
        return null;
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Manifest check failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = (await res.json());
    return { status: data.status ?? "unknown", progress: data.progress };
}
async function startSvf2Translation(token, urn, region, force) {
    const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
    };
    // C4: only send x-ads-force when explicitly requested — prevents wiping valid existing derivatives
    if (force)
        headers["x-ads-force"] = "true";
    const res = await apiFetch(`${MD_BASE}/designdata/job`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            input: { urn },
            output: {
                region, // H4: required for EMEA data-residency; harmless for US
                formats: [{ type: "svf2", views: ["2d", "3d"] }],
            },
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Translation job failed to start: HTTP ${res.status} — ${body.slice(0, 300)}`);
    }
}
function buildViewerHtml(urn, token, tokenTtlSeconds) {
    // C3: viewer mode is experimental — rendering as artifact depends on Claude Desktop heuristics.
    // C1: JSON.stringify() for safe embedding — guards against token/URN chars breaking JS string literals.
    // H3: tokenTtlSeconds is the actual remaining TTL from the cache, not a hardcoded 3600.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>APS Model Viewer</title>
  <link rel="stylesheet" href="${MD_BASE}/viewers/${VIEWER_VERSION}/style.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1e1e1e; overflow: hidden; }
    #viewer { width: 100vw; height: 100vh; }
    #msg {
      position: fixed; inset: 0; display: flex; align-items: center;
      justify-content: center; color: #ccc; font: 14px sans-serif;
      background: #1e1e1e; pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="viewer"></div>
  <div id="msg">Loading viewer…</div>
  <script src="${MD_BASE}/viewers/${VIEWER_VERSION}/viewer3D.min.js"></script>
  <script>
    (function () {
      var URN = ${JSON.stringify(urn)};
      var TOKEN = ${JSON.stringify(token)};
      var TTL = ${JSON.stringify(tokenTtlSeconds)};

      function onError(code, msg) {
        document.getElementById('msg').innerHTML =
          '<div style="text-align:center;padding:24px">' +
          '<b style="color:#f66">Viewer error ' + code + '</b><br>' + msg +
          '<br><br><small style="color:#999">If this is a network error, the artifact sandbox may be ' +
          'blocking APS CDN. Try <code>render_model(mode=\\"thumbnail\\")</code> instead.</small></div>';
      }

      Autodesk.Viewing.Initializer(
        {
          env: 'AutodeskProduction2',
          api: 'streamingV2',
          getAccessToken: function (cb) { cb(TOKEN, TTL); },
        },
        function () {
          document.getElementById('msg').textContent = 'Loading model…';
          var viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'));
          viewer.start();
          Autodesk.Viewing.Document.load(
            'urn:' + URN,
            function (doc) {
              document.getElementById('msg').remove();
              viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry());
            },
            onError
          );
        }
      );
    })();
  </script>
</body>
</html>`;
}
// ── Handler ───────────────────────────────────────────────────────────────
export async function handleRenderModel(input) {
    const urn = ossUrlToUrn(input.oss_url);
    // C2 + H5: two separate tokens with minimal scopes:
    //   writeToken  — data:read + data:write for manifest check and job POST
    //   viewerToken — viewables:read only for embedding in HTML (cannot download raw OSS objects)
    let writeToken;
    let viewerToken;
    let viewerTtl;
    try {
        const writeCred = await resolveCredential(["data:read", "data:write"]);
        const viewerCred = await resolveCredential(["viewables:read"]);
        writeToken = writeCred.access_token;
        viewerToken = viewerCred.access_token;
        viewerTtl = viewerCred.expires_in_seconds; // H3: actual remaining TTL, not hardcoded 3600
    }
    catch (err) {
        return {
            status: "error",
            error: `APS auth failed: ${String(err)}`,
            hint: "Run authenticate_aps first.",
        };
    }
    // Check manifest
    let manifest;
    try {
        manifest = await getManifestStatus(writeToken, urn);
    }
    catch (err) {
        return { status: "error", error: `Failed to check model status: ${String(err)}` };
    }
    if (!manifest) {
        // No translation exists — start one
        try {
            await startSvf2Translation(writeToken, urn, input.region, input.force_retranslate);
        }
        catch (err) {
            return { status: "error", error: `Failed to start SVF2 translation: ${String(err)}` };
        }
        return {
            status: "pending",
            urn,
            // M4: guidance on retry ceiling so users know when to stop
            message: "SVF2 translation started. Call render_model again in 30–60 seconds to check progress. " +
                "Large models (>50 MB) can take 10–30 minutes. " +
                "If still pending after 30 minutes, the job has likely timed out — re-upload and try again.",
        };
    }
    // H2: "timeout" is a terminal failure state — treat same as "failed", not as retryable pending
    if (manifest.status === "failed" || manifest.status === "timeout") {
        return {
            status: "error",
            error: `Translation ${manifest.status}. ` +
                "The model may be invalid, unsupported, or too large. " +
                "Re-upload the file and call render_model again. " +
                "If the problem persists, try a different format (e.g. IFC instead of RVT).",
        };
    }
    if (manifest.status !== "success") {
        return {
            status: "pending",
            urn,
            message: `Translation ${manifest.status} (${manifest.progress ?? "?"}%). ` +
                "Call render_model again to check. " +
                "If still pending after 30 minutes, the job may have timed out — re-upload and try again.", // M4
        };
    }
    // ── Translation complete ──────────────────────────────────────────────────
    if (input.mode === "thumbnail") {
        // H1: no encodeURIComponent — URN is already URL-safe base64url
        const res = await apiFetch(`${MD_BASE}/designdata/${urn}/thumbnail?width=400&height=400`, { headers: { Authorization: `Bearer ${writeToken}` } });
        if (!res.ok) {
            return { status: "error", error: `Thumbnail fetch failed: HTTP ${res.status}` };
        }
        // M3: read actual content-type from response — APS may return image/jpeg for some models
        const contentType = res.headers.get("content-type") ?? "image/png";
        const bytes = new Uint8Array(await res.arrayBuffer());
        return {
            status: "success",
            urn,
            message: "Model thumbnail (rendered by APS). Shown inline above.",
            image: { base64: Buffer.from(bytes).toString("base64"), mimeType: contentType },
        };
    }
    // ── Viewer mode: SVF2 translation → full interactive APS Viewer in the browser ──
    //
    // In-panel/inline 3D is parked (Claude Desktop artifact CSP blocks the live viewer; MCP Apps
    // inline UI hits host bug #165). The reliable Desktop deliverable: serve the viewer from the
    // local HTTP server and AUTO-OPEN it in the system browser. Also: record token usage (like
    // get_result) and offer to save the flow as a reusable skill.
    const viewerHtml = buildViewerHtml(urn, viewerToken, viewerTtl);
    const viewerUrl = registerViewer(viewerHtml, viewerTtl);
    const expiresAt = new Date(Date.now() + viewerTtl * 1000).toISOString();
    // Auto-open the viewer in the default browser (MCP runs locally on the Mac).
    let openedInBrowser = false;
    try {
        await execAsync(`open "${viewerUrl}"`);
        openedInBrowser = true;
    }
    catch {
        openedInBrowser = false; // fall back to the chat link
    }
    // Rendered preview → MCP image content block (for model awareness + the collapsed tool-result).
    // NOTE: every in-chat image channel on Claude Desktop has been empirically closed (image block =
    // collapsed-only, artifact data: URI = relay corruption, inline MCP UI = bug #165, external/
    // localhost Markdown image = "Show Image" gate that won't load). So the *visible deliverable* is
    // the interactive viewer link; the image block just lets the model describe the model + is
    // accessible by expanding the tool result.
    let previewImage;
    let thumbFetchNote = "";
    try {
        const res = await apiFetch(`${MD_BASE}/designdata/${urn}/thumbnail?width=400&height=400`, { headers: { Authorization: `Bearer ${writeToken}` } });
        if (res.ok) {
            const ct = res.headers.get("content-type") ?? "image/png";
            previewImage = {
                base64: Buffer.from(new Uint8Array(await res.arrayBuffer())).toString("base64"),
                mimeType: ct,
            };
        }
        else {
            thumbFetchNote = ` (preview thumbnail unavailable: HTTP ${res.status})`;
        }
    }
    catch (err) {
        thumbFetchNote = ` (preview thumbnail fetch error: ${String(err).slice(0, 80)})`;
    }
    const summaryLine = await tryAutoRecordTokens(input.model, input.estimated_input_tokens, input.estimated_output_tokens);
    // next_action chains: (1) save-as-skill offer, then (2) token tracking / summary_line.
    const tokenStep = summaryLine
        ? "Output the summary_line field verbatim as the LAST line of your response."
        : TOKEN_REMINDER;
    const next_action = `${SAVE_SKILL_OFFER} ${tokenStep}`;
    const openedMsg = openedInBrowser
        ? "Opened the interactive 3D viewer in your browser automatically."
        : "Could not auto-open the browser — share this link so the user can open it:";
    return {
        status: "success",
        urn,
        viewer_url: viewerUrl,
        opened_in_browser: openedInBrowser,
        expires_at: expiresAt,
        image: previewImage,
        summary_line: summaryLine,
        save_as_skill_offer: true,
        next_action,
        message: `Render complete${thumbFetchNote}. ${openedMsg} [Open interactive 3D viewer](${viewerUrl}) — ` +
            `the full model (orbit, zoom, isolate, inspect). Do NOT claim an image is shown inline. ` +
            `Session expires at ${expiresAt} (~${Math.floor(viewerTtl / 60)} min) — call render_model again to refresh. ` +
            `THEN: ${next_action}`,
    };
}
