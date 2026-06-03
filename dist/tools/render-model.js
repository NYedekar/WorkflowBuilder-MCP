import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
import { registerViewer } from "../lib/viewer-server.js";
const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";
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
    // ── Viewer mode: preview image in chat + interactive viewer link (Desktop, reliable) ──
    //
    // No artifact panel: Claude Desktop's artifact CSP blocks the live viewer, embedding the
    // preview as a base64 data: URI broke artifact rendering (relay corruption / panel won't open),
    // and MCP Apps inline UI is blocked by host bug #165. So we deliver only the two channels that
    // reliably work on Desktop today:
    //   (1) the rendered preview as an MCP image content block (chat), and
    //   (2) viewer_url → a chat Markdown link that opens the full interactive APS Viewer
    //       (served by the local HTTP server) in the system browser.
    // In-panel/inline 3D is parked until Claude Desktop fixes MCP Apps UI (#165).
    // Full interactive viewer, served from the local HTTP server — opened via the chat link.
    const viewerHtml = buildViewerHtml(urn, viewerToken, viewerTtl);
    const viewerUrl = registerViewer(viewerHtml, viewerTtl);
    const expiresAt = new Date(Date.now() + viewerTtl * 1000).toISOString();
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
    return {
        status: "success",
        urn,
        viewer_url: viewerUrl,
        expires_at: expiresAt,
        image: previewImage,
        message: `Render complete${thumbFetchNote}. Post this link as the deliverable — it opens the full ` +
            `interactive 3D model in the browser (orbit, zoom, isolate, inspect): ` +
            `[Open interactive 3D viewer](${viewerUrl}) . ` +
            `Do NOT claim an image is shown inline (Claude Desktop can't render one here). ` +
            `Session expires at ${expiresAt} (~${Math.floor(viewerTtl / 60)} min) — call render_model again to refresh.`,
    };
}
