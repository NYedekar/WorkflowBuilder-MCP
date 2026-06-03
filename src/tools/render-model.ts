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
    .describe(
      "The oss:// URL of the model file (e.g. oss://bucket/model.rvt). " +
        "The model must already be in APS OSS — upload it with upload_file first."
    ),
  mode: z
    .enum(["viewer", "thumbnail"])
    .optional()
    .default("viewer")
    .describe(
      "'viewer' (default): auto-translates to SVF2 if needed, returns artifact_html " +
        "(a rendered preview card for the right panel) plus viewer_url (a localhost link to the " +
        "full interactive APS Viewer that Claude posts as a chat link — opens in the browser). " +
        "'thumbnail': returns a 400×400 PNG image inline in chat."
    ),
  region: z
    .enum(["US", "EMEA"])
    .optional()
    .default("US")
    .describe(
      "Region for storing SVF2 derivatives. Default: 'US'. " +
        "Use 'EMEA' for EU data-residency compliance."
    ), // H4
  force_retranslate: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Force re-translation even if SVF2 derivatives already exist. " +
        "Deletes the existing manifest and restarts from scratch. " +
        "Use only if a previous translation produced a corrupt or incomplete result."
    ), // C4
});

export type RenderModelInput = z.infer<typeof renderModelSchema>;

// `image`, when present, is emitted by index.ts as a real MCP image content block
// (the host renders the bytes directly). NEVER embed base64 in artifact_html — Claude
// would have to relay the whole blob verbatim into the artifact, which it truncates,
// producing a broken image (confirmed live 2026-06-03).
export type RenderModelOutput =
  | { status: "success"; urn: string; artifact_html: string; viewer_url: string; expires_at: string; message: string; image?: { base64: string; mimeType: string } }  // viewer: panel card + chat image + chat link
  | { status: "success"; urn: string; message: string; image: { base64: string; mimeType: string } }                                                                  // thumbnail: chat image block
  | { status: "pending"; urn: string; message: string }
  | { status: "error"; error: string; hint?: string };

// ── Helpers ───────────────────────────────────────────────────────────────

function ossUrlToUrn(ossUrl: string): string {
  const withoutScheme = ossUrl.replace(/^oss:\/\//, "");
  const resourceUrn = `urn:adsk.objects:os.object:${withoutScheme}`;
  return Buffer.from(resourceUrn).toString("base64url"); // L3: native Node 18+ base64url
}

// L1: default 30s (was 15s — manifest on large models can be hundreds of KB)
async function apiFetch(url: string, options: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getManifestStatus(
  token: string,
  urn: string
): Promise<{ status: string; progress?: string } | null> {
  // H1: URN is base64url — chars [A-Za-z0-9_-] are URL-safe; no encodeURIComponent needed
  const res = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Manifest check failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { status?: string; progress?: string };
  return { status: data.status ?? "unknown", progress: data.progress };
}

async function startSvf2Translation(
  token: string,
  urn: string,
  region: string,
  force: boolean
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  // C4: only send x-ads-force when explicitly requested — prevents wiping valid existing derivatives
  if (force) headers["x-ads-force"] = "true";

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
    throw new Error(
      `Translation job failed to start: HTTP ${res.status} — ${body.slice(0, 300)}`
    );
  }
}

function buildViewerHtml(urn: string, token: string, tokenTtlSeconds: number): string {
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

export async function handleRenderModel(input: RenderModelInput): Promise<RenderModelOutput> {
  const urn = ossUrlToUrn(input.oss_url);

  // C2 + H5: two separate tokens with minimal scopes:
  //   writeToken  — data:read + data:write for manifest check and job POST
  //   viewerToken — viewables:read only for embedding in HTML (cannot download raw OSS objects)
  let writeToken: string;
  let viewerToken: string;
  let viewerTtl: number;
  try {
    const writeCred  = await resolveCredential(["data:read", "data:write"]);
    const viewerCred = await resolveCredential(["viewables:read"]);
    writeToken  = writeCred.access_token;
    viewerToken = viewerCred.access_token;
    viewerTtl   = viewerCred.expires_in_seconds; // H3: actual remaining TTL, not hardcoded 3600
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  // Check manifest
  let manifest: { status: string; progress?: string } | null;
  try {
    manifest = await getManifestStatus(writeToken, urn);
  } catch (err) {
    return { status: "error", error: `Failed to check model status: ${String(err)}` };
  }

  if (!manifest) {
    // No translation exists — start one
    try {
      await startSvf2Translation(writeToken, urn, input.region!, input.force_retranslate!);
    } catch (err) {
      return { status: "error", error: `Failed to start SVF2 translation: ${String(err)}` };
    }
    return {
      status: "pending",
      urn,
      // M4: guidance on retry ceiling so users know when to stop
      message:
        "SVF2 translation started. Call render_model again in 30–60 seconds to check progress. " +
        "Large models (>50 MB) can take 10–30 minutes. " +
        "If still pending after 30 minutes, the job has likely timed out — re-upload and try again.",
    };
  }

  // H2: "timeout" is a terminal failure state — treat same as "failed", not as retryable pending
  if (manifest.status === "failed" || manifest.status === "timeout") {
    return {
      status: "error",
      error:
        `Translation ${manifest.status}. ` +
        "The model may be invalid, unsupported, or too large. " +
        "Re-upload the file and call render_model again. " +
        "If the problem persists, try a different format (e.g. IFC instead of RVT).",
    };
  }

  if (manifest.status !== "success") {
    return {
      status: "pending",
      urn,
      message:
        `Translation ${manifest.status} (${manifest.progress ?? "?"}%). ` +
        "Call render_model again to check. " +
        "If still pending after 30 minutes, the job may have timed out — re-upload and try again.", // M4
    };
  }

  // ── Translation complete ──────────────────────────────────────────────────

  if (input.mode === "thumbnail") {
    // H1: no encodeURIComponent — URN is already URL-safe base64url
    const res = await apiFetch(
      `${MD_BASE}/designdata/${urn}/thumbnail?width=400&height=400`,
      { headers: { Authorization: `Bearer ${writeToken}` } }
    );
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

  // ── Viewer mode (Phase 1: static preview in panel + interactive viewer link) ──
  //
  // Claude Desktop's artifact sandbox CSP forbids the live APS Viewer outright:
  //   • script-src   → only cdnjs / pyodide  (APS Viewer SDK can't load)
  //   • connect-src  → only pyodide          (geometry streaming can't happen)
  //   • frame-src    → claudeusercontent.com (nested localhost iframe is blocked)
  //   • + block-all-mixed-content            (http://127.0.0.1 is killed)
  // img-src DOES allow data: URIs, so a rendered still IS displayable in the panel.
  //
  // Strategy: show a high-quality rendered preview in the panel (data: URI, CSP-safe),
  // and hand Claude the localhost viewer URL to post as a CHAT link — clicked from the
  // chat (not the sandbox) it opens the full interactive APS Viewer in the system browser.
  // (Phase 2 will render real interactive 3D in-panel via three.js + a server-side glTF.)

  // Full interactive viewer, served from the local HTTP server — opened via the chat link.
  const viewerHtml = buildViewerHtml(urn, viewerToken, viewerTtl);
  const viewerUrl = registerViewer(viewerHtml, viewerTtl);
  const expiresAt = new Date(Date.now() + viewerTtl * 1000).toISOString();

  // Rendered preview. Delivered TWO ways for resilience:
  //   (a) embedded in the panel artifact as a data: URI (200×200 → ~9KB base64 — small enough
  //       for Claude to relay faithfully; a 400×400 ~13KB blob got truncated → broken image),
  //       with an SVG fallback via onerror so the panel never shows a broken icon.
  //   (b) as an MCP image content block (index.ts), which renders in the chat/tool-result area.
  // Thumbnail derivative is confirmed present for SVF2 translations (verified live 2026-06-03).
  let previewImage: { base64: string; mimeType: string } | undefined;
  let thumbFetchNote = "";
  try {
    const res = await apiFetch(
      `${MD_BASE}/designdata/${urn}/thumbnail?width=200&height=200`,
      { headers: { Authorization: `Bearer ${writeToken}` } }
    );
    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "image/png";
      previewImage = {
        base64: Buffer.from(new Uint8Array(await res.arrayBuffer())).toString("base64"),
        mimeType: ct,
      };
    } else {
      thumbFetchNote = ` (thumbnail HTTP ${res.status})`;
    }
  } catch (err) {
    thumbFetchNote = ` (thumbnail fetch error: ${String(err).slice(0, 80)})`;
  }

  const objectKey = input.oss_url.split("/").pop() ?? "model";
  const fileName = objectKey.replace(/[<>&"']/g, ""); // sanitize for HTML text node

  // Lightweight, base64-free card: inline SVG wireframe cube + the viewer button.
  // Small enough for Claude to reproduce faithfully into the artifact.
  const artifactHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1b1b1f; color: #e8e8ea; font: 14px/1.5 -apple-system, system-ui, sans-serif;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 560px; background: #232329; border: 1px solid #34343c;
            border-radius: 16px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
    .hd { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid #34343c; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #36c46f; box-shadow: 0 0 8px #36c46f99; }
    .hd .t { font-weight: 600; }
    .hd .f { margin-left: auto; font-size: 12px; opacity: .6; max-width: 50%; overflow: hidden;
             text-overflow: ellipsis; white-space: nowrap; }
    .stage { background: radial-gradient(ellipse at center, #2c2c34 0%, #1b1b1f 100%);
             display: flex; flex-direction: column; align-items: center; justify-content: center;
             gap: 14px; padding: 32px 24px; }
    .stage svg { filter: drop-shadow(0 6px 16px rgba(0,0,0,.4)); }
    .stage img.thumb { max-width: 100%; max-height: 300px; border-radius: 10px;
                       box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .stage .cap { color: #b9b9c2; font-size: 13px; text-align: center; }
    .ft { padding: 16px 18px; border-top: 1px solid #34343c; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
           padding: 12px; border-radius: 10px; background: #2563eb; color: #fff; font-weight: 600;
           text-decoration: none; }
    .note { margin-top: 10px; font-size: 12px; opacity: .6; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="hd"><span class="dot"></span><span class="t">APS Model · Translated to SVF2</span><span class="f">${fileName}</span></div>
    <div class="stage">
      ${previewImage
        ? `<img class="thumb" src="data:${previewImage.mimeType};base64,${previewImage.base64}" alt="Rendered preview of ${fileName}" onerror="this.style.display='none';document.getElementById('fallbk').style.display='flex'">`
        : ``}
      <div id="fallbk" style="display:${previewImage ? "none" : "flex"};flex-direction:column;align-items:center;gap:14px">
        <svg width="92" height="92" viewBox="0 0 100 100" fill="none" stroke="#6aa3ff" stroke-width="2.5" stroke-linejoin="round">
          <path d="M50 8 L88 30 L88 70 L50 92 L12 70 L12 30 Z"/>
          <path d="M50 8 L50 50 M50 50 L88 30 M50 50 L12 30" stroke="#3f6bbf"/>
          <path d="M50 50 L50 92" stroke="#3f6bbf"/>
        </svg>
      </div>
      <div class="cap">${previewImage ? "Rendered preview · APS Model Derivative" : "Model ready for the interactive viewer"}</div>
    </div>
    <div class="ft">
      <a class="btn" href="${viewerUrl}" target="_blank" rel="noopener">🧭 Open interactive 3D viewer</a>
      <div class="note">
        Drag to orbit · scroll to zoom — opens in your browser.<br>
        If the button doesn't open, click the viewer link in the chat. Session expires ~${Math.floor(viewerTtl / 60)} min.
      </div>
    </div>
  </div>
</body>
</html>`;

  return {
    status: "success",
    urn,
    artifact_html: artifactHtml,
    viewer_url: viewerUrl,
    expires_at: expiresAt,
    image: previewImage,
    message:
      `Render complete${thumbFetchNote}. Do both: ` +
      `(1) Present artifact_html VERBATIM as an HTML artifact titled "APS Model Preview" in the right panel — ` +
      `it contains the rendered preview image (200×200) plus the viewer button. Reproduce it EXACTLY, character-for-character, including the data: URI. ` +
      `(2) In your chat reply include this exact Markdown link for the full interactive viewer: [Open interactive 3D viewer](${viewerUrl}) . ` +
      `The same preview is also attached as an image block (shows in the tool result). ` +
      `Session token expires at ${expiresAt} (~${Math.floor(viewerTtl / 60)} min) — call render_model again to refresh.`,
  };
}
