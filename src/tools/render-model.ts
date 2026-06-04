import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveCredential } from "../auth/credential-resolver.js";
import { handleRecordTokenUsage } from "./record-token-usage.js";

const execAsync = promisify(exec);

const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";

// Mirrors get_result's token-tracking + save-as-skill flow so render_model behaves consistently.
const TOKEN_REMINDER =
  "TOKEN TRACKING: call record_token_usage(model=<your model ID>, input_tokens=<total session estimate>, " +
  "output_tokens=<total session estimate>), then output the returned summary_line verbatim as the LAST line of your response.";

const SAVE_SKILL_OFFER =
  "Then — if rendering models like this is something the user might do again, and this was NOT launched from a " +
  'saved workflow (run_saved_workflow) — ASK: "Want me to save this as a reusable skill you can re-run on any file?" ' +
  "If yes, call save_workflow_as_skill with the exact steps you just ran (upload_file → render_model).";

async function tryAutoRecordTokens(
  model?: string,
  inTok?: number,
  outTok?: number
): Promise<string | undefined> {
  if (!model || !inTok || !outTok) return undefined;
  try {
    return (await handleRecordTokenUsage({ model, input_tokens: inTok, output_tokens: outTok })).summary_line;
  } catch {
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
    .describe(
      "The oss:// URL of the model file (e.g. oss://bucket/model.rvt). " +
        "The model must already be in APS OSS — upload it with upload_file first."
    ),
  mode: z
    .enum(["viewer", "thumbnail"])
    .optional()
    .default("viewer")
    .describe(
      "'viewer' (default): auto-translates to SVF2 if needed; saves a self-contained Autodesk Viewer " +
        "HTML file to ~/Downloads and auto-opens it in the browser (returns file_path). The file is " +
        "emailable and shows the full model (valid ~1h until the embedded token expires). " +
        "'thumbnail': returns just the rendered preview image inline in chat."
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
  model: z
    .string()
    .optional()
    .describe(
      "Your model ID (e.g. 'claude-sonnet-4-6'). Provide with estimated_input_tokens and " +
        "estimated_output_tokens to auto-record token usage inline (like get_result) — returns a summary_line."
    ),
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
  root_filename: z
    .string()
    .optional()
    .describe(
      "Override the filename hint sent to Model Derivative. Use when the OSS object key has the wrong " +
        "extension (e.g. DA output saved as '.json' but is really a Revit file). " +
        "Example: 'model.rvt'. MD uses this to select the correct translator."
    ),
});

export type RenderModelInput = z.infer<typeof renderModelSchema>;

// `image`, when present, is emitted by index.ts as a real MCP image content block
// (the host renders the bytes directly — no LLM relay).
//
// Desktop strategy (chosen 2026-06-03 after MCP Apps UI host bug #165 blocked inline render,
// and artifact-relay corrupted/failed for embedded images): NO artifact panel. The viewer is
// delivered as (1) a preview image content block in chat, and (2) viewer_url that Claude posts
// as a chat Markdown link → opens the full interactive APS Viewer (local server) in the browser.
// Inline in-panel rendering is parked until Claude Desktop fixes MCP Apps UI (#165).
export type RenderModelOutput =
  | { status: "success"; urn: string; file_path: string; opened_in_browser?: boolean; expires_at: string; message: string; next_action?: string; summary_line?: string; save_as_skill_offer?: boolean; image?: { base64: string; mimeType: string } }  // viewer: emailable APS Viewer HTML file, auto-opened + token + skill offer
  | { status: "success"; urn: string; message: string; image: { base64: string; mimeType: string } }                                            // thumbnail: chat image block
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
  force: boolean,
  rootFilename?: string
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  // C4: only send x-ads-force when explicitly requested — prevents wiping valid existing derivatives
  if (force) headers["x-ads-force"] = "true";

  // rootFilename tells MD the real file type when the OSS key has the wrong extension
  // (e.g. DA output stored as .json but actually an RVT binary)
  const inputBlock: Record<string, unknown> = { urn };
  if (rootFilename) inputBlock.rootFilename = rootFilename;

  const res = await apiFetch(`${MD_BASE}/designdata/job`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: inputBlock,
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

function buildViewerHtml(urn: string, token: string, tokenTtlSeconds: number, sessionId: string, ossUrl: string): string {
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
    /* BIM properties panel (click an element → its data) */
    #bim { position: fixed; top: 16px; right: 16px; bottom: 16px; width: 344px; max-width: 84vw;
           background: rgba(30,31,36,.92); color: #ececf0; font: 12.5px/1.5 -apple-system, system-ui, sans-serif;
           border: 1px solid #3c3d44; border-radius: 14px; box-shadow: 0 14px 44px rgba(0,0,0,.5);
           display: none; flex-direction: column; overflow: hidden; z-index: 10; -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
    #bim .h { padding: 15px 18px 13px; border-bottom: 1px solid #3c3d44; position: relative;
              background: linear-gradient(180deg, rgba(45,46,53,.6), rgba(30,31,36,0)); }
    #bim .h .name { font-size: 15px; font-weight: 650; letter-spacing: -.01em; padding-right: 24px; }
    #bim .h .sub { font-size: 11px; opacity: .5; margin-top: 3px; }
    #bim .h .x { position: absolute; top: 11px; right: 14px; cursor: pointer; opacity: .45; font-size: 21px; line-height: 1; }
    #bim .h .x:hover { opacity: 1; }
    #bim .body { overflow-y: auto; padding-bottom: 12px; }
    #bim .body::-webkit-scrollbar { width: 9px; }
    #bim .body::-webkit-scrollbar-thumb { background: #4a4b52; border-radius: 5px; border: 2px solid transparent; background-clip: padding-box; }
    #bim .cat { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em;
                color: #7fb0ff; padding: 15px 18px 6px; }
    #bim .row { display: flex; justify-content: space-between; gap: 14px; padding: 4px 18px; border-radius: 5px; }
    #bim .row:hover { background: rgba(255,255,255,.045); }
    #bim .row .k { opacity: .6; flex: 0 1 auto; min-width: 0; }
    #bim .row .val-wrap { display: flex; align-items: center; gap: 5px; justify-content: flex-end; max-width: 58%; min-width: 0; }
    #bim .row .v { text-align: right; word-break: break-word; font-variant-numeric: tabular-nums; min-width: 0; }
    #bim .row.edited .v { color: #7fb0ff; }
    #bim .edit-btn { opacity: 0; cursor: pointer; background: none; border: none; padding: 0 2px;
                     color: #7fb0ff; font-size: 12px; line-height: 1; transition: opacity .15s; flex-shrink: 0; }
    #bim .row:hover .edit-btn { opacity: .55; }
    #bim .edit-btn:hover { opacity: 1 !important; }
    #bim input.edit-field { background: rgba(127,176,255,.1); border: 1px solid rgba(127,176,255,.35);
                             border-radius: 4px; color: #ececf0; font: inherit; padding: 1px 5px;
                             width: 110px; text-align: right; outline: none; }
    #bim input.edit-field:focus { border-color: #7fb0ff; }
    #bim .edit-actions { display: flex; gap: 2px; align-items: center; }
    #bim .edit-actions button { background: none; border: none; cursor: pointer; font-size: 13px; padding: 0 2px; line-height: 1; }
    #bim .edit-actions .ok { color: #5cf; }
    #bim .edit-actions .cancel { color: #f77; }
    #bim .footer { border-top: 1px solid #3c3d44; padding: 12px 16px; flex-shrink: 0; }
    #bim .apply-btn { width: 100%; padding: 9px 14px; background: rgba(127,176,255,.12); border: 1px solid rgba(127,176,255,.45);
                      border-radius: 9px; color: #7fb0ff; font: 13px -apple-system, system-ui, sans-serif;
                      cursor: pointer; transition: background .15s; text-align: center; }
    #bim .apply-btn:hover { background: rgba(127,176,255,.22); }
    #bim .apply-status { font-size: 12px; opacity: .7; text-align: center; padding: 4px 0; }
    #bim .apply-status.done { color: #5cf; opacity: 1; }
    #apply-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.78); z-index: 20; display: none;
                     align-items: center; justify-content: center; font: 14px -apple-system, system-ui, sans-serif; color: #ececf0; }
    #apply-overlay .box { background: #2a2b30; border: 1px solid #3c3d44; border-radius: 14px;
                           padding: 26px 28px; max-width: 440px; width: 90vw; box-shadow: 0 18px 56px rgba(0,0,0,.6); }
    #apply-overlay .title { font-size: 15px; font-weight: 650; margin-bottom: 6px; }
    #apply-overlay .sub { font-size: 12px; opacity: .55; margin-bottom: 14px; line-height: 1.5; }
    #apply-overlay .change-list { max-height: 180px; overflow-y: auto; background: rgba(0,0,0,.22);
                                   border-radius: 8px; padding: 8px 12px; margin-bottom: 18px; }
    #apply-overlay .ci { font-size: 12px; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
    #apply-overlay .ci:last-child { border-bottom: none; }
    #apply-overlay .ci b { color: #ececf0; }
    #apply-overlay .ci .who { opacity: .45; font-size: 11px; }
    #apply-overlay .btns { display: flex; gap: 10px; }
    #apply-overlay button { flex: 1; padding: 10px; border-radius: 8px; font: 13px -apple-system, system-ui, sans-serif; cursor: pointer; border: 1px solid; }
    #apply-overlay .cxl { background: transparent; border-color: #4a4b52; color: #ececf0; }
    #apply-overlay .cxl:hover { background: rgba(255,255,255,.05); }
    #apply-overlay .cfm { background: rgba(127,176,255,.15); border-color: #7fb0ff; color: #7fb0ff; }
    #apply-overlay .cfm:hover { background: rgba(127,176,255,.25); }
    #hint { position: fixed; bottom: 14px; left: 16px; color: #cfcfd6; font: 12px -apple-system, system-ui, sans-serif;
            background: rgba(42,43,48,.85); padding: 7px 13px; border-radius: 9px; border: 1px solid #3c3d44; z-index: 9; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
  </style>
</head>
<body>
  <div id="viewer"></div>
  <div id="bim"></div>
  <div id="apply-overlay"></div>
  <div id="hint">Click any element to see its BIM data · Edit values with ✎ · Apply to Model to write back</div>
  <div id="msg">Loading viewer…</div>
  <script src="${MD_BASE}/viewers/${VIEWER_VERSION}/viewer3D.min.js"></script>
  <script>
    (function () {
      var URN = ${JSON.stringify(urn)};
      var TOKEN = ${JSON.stringify(token)};
      var TTL = ${JSON.stringify(tokenTtlSeconds)};
      var SESSION_ID = ${JSON.stringify(sessionId)};
      var OSS_URL = ${JSON.stringify(ossUrl)};
      var LOCAL_SERVER = 'http://127.0.0.1:7830';

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

          function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
          function fmt(v) {
            if (typeof v === 'number' && isFinite(v)) return v.toFixed(2);
            if (typeof v === 'string') return v.replace(/-?\\d+\\.\\d+/g, function (m) { return parseFloat(m).toFixed(2); });
            return String(v == null ? '' : v);
          }

          var panel       = document.getElementById('bim');
          var overlay     = document.getElementById('apply-overlay');
          var edits       = {};               // key: dbId+'::'+displayName → edited value string
          var externalIds = {};               // dbId → externalId (Revit ElementId)
          var elemNames   = {};               // dbId → element name (fallback for DA matching)
          var applyState  = 'idle';           // 'idle' | 'submitted' | 'done' | 'failed'
          var pollTimer   = null;

          // ── Render BIM panel ──────────────────────────────────────────────
          function renderPanel(dbId, data) {
            if (data.externalId) externalIds[dbId] = String(data.externalId);
            if (data.name)       elemNames[dbId]   = data.name;

            var groups = {}, count = 0;
            var ALWAYS_SHOW = ['Comments', 'Mark', 'Type Comments'];
            (data.properties || []).forEach(function (p) {
              if (p.hidden) return;
              var isEmpty = p.displayValue === '' || p.displayValue == null;
              if (isEmpty && ALWAYS_SHOW.indexOf(p.displayName) === -1) return;
              var cat = p.displayCategory || 'Other';
              (groups[cat] = groups[cat] || []).push(p); count++;
            });
            var idLine = 'dbId: ' + dbId;
            if (data.externalId) {
              var decoded = decodeRevitElementId(String(data.externalId));
              idLine += ' · ElementId: ' + esc(decoded);
              // If the UniqueId was decoded to a different value, also show the raw UniqueId
              if (decoded !== String(data.externalId)) {
                idLine += ' (uid …' + esc(String(data.externalId).slice(-8)) + ')';
              }
            }
            var html = '<div class="h"><div class="name">' + esc(data.name || 'Element') +
                       '</div><div class="sub">' + esc(idLine) + ' · ' + count + ' propert' + (count === 1 ? 'y' : 'ies') +
                       '</div><span class="x">×</span></div><div class="body">';
            Object.keys(groups).forEach(function (cat) {
              html += '<div class="cat">' + esc(cat) + '</div>';
              groups[cat].forEach(function (p) {
                var editKey = dbId + '::' + p.displayName;
                var cur = edits[editKey] !== undefined ? edits[editKey] : p.displayValue;
                var isEdited = edits[editKey] !== undefined;
                html += '<div class="row' + (isEdited ? ' edited' : '') + '" data-key="' + esc(editKey) +
                        '" data-orig="' + esc(String(p.displayValue)) + '">' +
                        '<span class="k">' + esc(p.displayName) + '</span>' +
                        '<span class="val-wrap">' +
                        '<span class="v">' + esc(fmt(cur)) + '</span>' +
                        '<button class="edit-btn" title="Edit value">✎</button>' +
                        '</span></div>';
              });
            });
            html += '</div>';

            // Footer — shows Apply button, submission status, or done banner
            var editCount = Object.keys(edits).length;
            html += '<div class="footer">';
            if (applyState === 'done') {
              html += '<div class="apply-status done">✓ Model updated — new viewer opened</div>';
            } else if (applyState === 'submitted') {
              html += '<div class="apply-status">Changes submitted — ask Claude: "apply viewer updates"</div>';
            } else if (editCount > 0) {
              html += '<button class="apply-btn">' + editCount + ' edit' + (editCount === 1 ? '' : 's') +
                      ' — Apply to Model</button>';
            }
            html += '</div>';

            panel.innerHTML = html;
            panel.style.display = 'flex';
            var hint = document.getElementById('hint'); if (hint) hint.remove();
          }

          // Revit UniqueId → integer ElementId.
          // UniqueId format: {GUID 5-part}-{8-hex ElementId}  e.g. "a6aa132d-...-0003b64a" → "243274"
          function decodeRevitElementId(uid) {
            if (!uid) return uid;
            var parts = uid.split('-');
            // Standard Revit UniqueId has 6 dash-separated segments; last is the hex ElementId
            if (parts.length === 6) {
              var n = parseInt(parts[5], 16);
              if (!isNaN(n) && n > 0) return String(n);
            }
            return uid; // not a recognisable UniqueId — pass through unchanged
          }

          // ── Build changes array from edits map ────────────────────────────
          function buildChanges() {
            return Object.keys(edits).map(function (key) {
              var parts    = key.split('::');
              var dbId     = parts[0];
              var propName = parts.slice(1).join('::');
              var rawId    = externalIds[dbId] || dbId;
              return {
                elementId:   decodeRevitElementId(rawId),
                elementName: elemNames[dbId] || '',
                parameter:   propName,
                value:       edits[key]
              };
            });
          }

          // ── Show confirmation overlay ─────────────────────────────────────
          function showConfirmOverlay() {
            var changes  = buildChanges();
            var listHtml = changes.map(function (c) {
              return '<div class="ci"><b>' + esc(c.parameter) + '</b> → ' + esc(c.value) +
                     ' <span class="who">(' + esc(c.elementName || c.elementId) + ')</span></div>';
            }).join('');
            overlay.innerHTML =
              '<div class="box">' +
              '<div class="title">Apply ' + changes.length + ' change' + (changes.length === 1 ? '' : 's') + ' to Model</div>' +
              '<div class="sub">Saves changes to the local server, then ask Claude to run<br>' +
              '<b>apply_viewer_updates</b> (session: ' + esc(SESSION_ID) + ') to kick off the DA job.</div>' +
              '<div class="change-list">' + listHtml + '</div>' +
              '<div class="btns">' +
              '<button class="cxl">Cancel</button>' +
              '<button class="cfm">Submit Changes</button>' +
              '</div></div>';
            overlay.style.display = 'flex';
          }

          // ── Submit to local server + start polling ────────────────────────
          function submitChanges() {
            var changes = buildChanges();
            overlay.innerHTML =
              '<div class="box">' +
              '<div class="title">Changes Saved</div>' +
              '<div class="sub">Ask Claude: <b>"apply viewer updates"</b><br>' +
              'Session ID: <code>' + esc(SESSION_ID) + '</code></div>' +
              '<div class="btns" style="margin-top:18px"><button class="cxl">Close</button></div>' +
              '</div>';
            applyState = 'submitted';

            fetch(LOCAL_SERVER + '/pending/' + SESSION_ID, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: SESSION_ID, oss_url: OSS_URL, changes: changes })
            }).catch(function () { /* server may not be running — changes shown on screen */ });

            startPolling();
          }

          // ── Poll for job completion ───────────────────────────────────────
          function startPolling() {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(function () {
              fetch(LOCAL_SERVER + '/pending/' + SESSION_ID + '/status')
                .then(function (r) { return r.json(); })
                .then(function (data) {
                  if (data.status === 'done') {
                    applyState = 'done';
                    clearInterval(pollTimer); pollTimer = null;
                    var fp = data.new_file_path ? esc(data.new_file_path) : '';
                    overlay.innerHTML =
                      '<div class="box">' +
                      '<div class="title" style="color:#5cf">✓ Model Updated!</div>' +
                      '<div class="sub">The Revit model has been updated. A new viewer has been opened in your browser.' +
                      (fp ? '<br><small style="opacity:.5">' + fp + '</small>' : '') + '</div>' +
                      '<div class="btns" style="margin-top:18px"><button class="cxl">Close</button></div></div>';
                    overlay.style.display = 'flex';
                  } else if (data.status === 'failed') {
                    applyState = 'failed';
                    clearInterval(pollTimer); pollTimer = null;
                    overlay.innerHTML =
                      '<div class="box">' +
                      '<div class="title" style="color:#f77">✗ Update Failed</div>' +
                      '<div class="sub">' + esc(data.error || 'DA job failed') + '</div>' +
                      '<div class="btns" style="margin-top:18px"><button class="cxl">Close</button></div></div>';
                    overlay.style.display = 'flex';
                  }
                })
                .catch(function () { /* server may not be up yet */ });
            }, 10000);
          }

          // ── Event delegation: panel + overlay ────────────────────────────
          document.addEventListener('click', function (e) {
            var t = e.target;
            // Panel close
            if (t.classList.contains('x')) { panel.style.display = 'none'; viewer.clearSelection(); return; }

            // Row edits
            var row = t.closest ? t.closest('.row') : null;
            var key = row ? row.getAttribute('data-key') : null;
            if (t.classList.contains('edit-btn') && row) {
              var orig = row.getAttribute('data-orig');
              var cur  = edits[key] !== undefined ? edits[key] : orig;
              row.querySelector('.val-wrap').innerHTML =
                '<input class="edit-field" value="' + esc(fmt(cur)) + '">' +
                '<span class="edit-actions"><button class="ok" title="Apply">✓</button>' +
                '<button class="cancel" title="Cancel">×</button></span>';
              var inp = row.querySelector('input'); inp.focus(); inp.select();
              return;
            }
            if (t.classList.contains('ok') && row) {
              var inp2 = row.querySelector('input.edit-field');
              edits[key] = inp2.value; row.classList.add('edited');
              row.querySelector('.val-wrap').innerHTML =
                '<span class="v">' + esc(fmt(inp2.value)) + '</span>' +
                '<button class="edit-btn" title="Edit value">✎</button>';
              // Refresh footer edit count
              var footer = panel.querySelector('.footer');
              if (footer) {
                var cnt = Object.keys(edits).length;
                footer.innerHTML = (applyState === 'idle' && cnt > 0)
                  ? '<button class="apply-btn">' + cnt + ' edit' + (cnt === 1 ? '' : 's') + ' — Apply to Model</button>'
                  : footer.innerHTML;
              }
              return;
            }
            if (t.classList.contains('cancel') && row) {
              var orig3 = row.getAttribute('data-orig');
              var cur3  = edits[key] !== undefined ? edits[key] : orig3;
              row.querySelector('.val-wrap').innerHTML =
                '<span class="v">' + esc(fmt(cur3)) + '</span>' +
                '<button class="edit-btn" title="Edit value">✎</button>';
              return;
            }

            // Apply button
            if (t.classList.contains('apply-btn')) { showConfirmOverlay(); return; }

            // Overlay buttons
            if (t.classList.contains('cfm')) { submitChanges(); return; }
            if (t.classList.contains('cxl')) { overlay.style.display = 'none'; return; }
          });

          // Enter / Escape in edit inputs
          document.addEventListener('keydown', function (e) {
            if (!e.target || e.target.tagName !== 'INPUT' || !e.target.classList.contains('edit-field')) return;
            if (e.key === 'Enter')  { e.target.closest('.row').querySelector('.ok').click();     e.preventDefault(); }
            if (e.key === 'Escape') { e.target.closest('.row').querySelector('.cancel').click(); e.preventDefault(); }
          });

          // AGGREGATE_SELECTION_CHANGED_EVENT gives (model, dbIdArray) directly — avoids the
          // multi-model routing bug in viewer.getProperties() that resolves the wrong node.
          viewer.addEventListener(Autodesk.Viewing.AGGREGATE_SELECTION_CHANGED_EVENT, function (e) {
            if (!e.selections || !e.selections.length || !e.selections[0].dbIdArray.length) {
              panel.style.display = 'none'; return;
            }
            var sel   = e.selections[0];
            var model = sel.model;
            var dbId  = sel.dbIdArray[0];
            model.getProperties(dbId, function (data) {
              renderPanel(dbId, data);
            }, function () { /* getProperties failed — leave panel as-is */ });
          });

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
      await startSvf2Translation(writeToken, urn, input.region!, input.force_retranslate!, input.root_filename);
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

  // ── Viewer mode (Flavor A): self-contained APS Viewer HTML file, auto-opened + emailable ──
  //
  // Writes a standalone HTML page (embeds a short-lived viewables:read token) to ~/Downloads and
  // opens it in the browser. The FILE is emailable — a recipient opens it directly and gets the
  // full Autodesk Viewer (real geometry + materials + BIM), valid until the token expires (~1h;
  // APS 2LO cap). Durable/shareable links come later via a hosted token-endpoint service.
  // (In-panel 3D parked: Claude Desktop artifact CSP blocks the live viewer; MCP Apps UI = #165.)
  const { randomBytes } = await import("crypto");
  const sessionId = randomBytes(8).toString("hex");
  const viewerHtml = buildViewerHtml(urn, viewerToken, viewerTtl, sessionId, input.oss_url);
  const expiresAt = new Date(Date.now() + viewerTtl * 1000).toISOString();

  const objectKey = input.oss_url.split("/").pop() ?? "model";
  const safeName =
    objectKey.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 60) || "model";
  const filePath = path.join(os.homedir(), "Downloads", `aps-viewer-${safeName}.html`);

  let openedInBrowser = false;
  try {
    fs.writeFileSync(filePath, viewerHtml, "utf-8");
  } catch (err) {
    return {
      status: "error",
      error: `Failed to save viewer HTML: ${String(err)}`,
      hint: "Check that ~/Downloads is writable.",
    };
  }
  // Auto-open the file in the default browser (MCP runs locally on the Mac).
  try {
    await execAsync(`open "${filePath}"`);
    openedInBrowser = true;
  } catch {
    openedInBrowser = false; // user can double-click the file manually
  }

  // Rendered preview → MCP image content block (for model awareness + the collapsed tool-result).
  // NOTE: every in-chat image channel on Claude Desktop has been empirically closed (image block =
  // collapsed-only, artifact data: URI = relay corruption, inline MCP UI = bug #165, external/
  // localhost Markdown image = "Show Image" gate that won't load). So the *visible deliverable* is
  // the interactive viewer link; the image block just lets the model describe the model + is
  // accessible by expanding the tool result.
  let previewImage: { base64: string; mimeType: string } | undefined;
  let thumbFetchNote = "";
  try {
    const res = await apiFetch(
      `${MD_BASE}/designdata/${urn}/thumbnail?width=400&height=400`,
      { headers: { Authorization: `Bearer ${writeToken}` } }
    );
    if (res.ok) {
      const ct = res.headers.get("content-type") ?? "image/png";
      previewImage = {
        base64: Buffer.from(new Uint8Array(await res.arrayBuffer())).toString("base64"),
        mimeType: ct,
      };
    } else {
      thumbFetchNote = ` (preview thumbnail unavailable: HTTP ${res.status})`;
    }
  } catch (err) {
    thumbFetchNote = ` (preview thumbnail fetch error: ${String(err).slice(0, 80)})`;
  }

  const summaryLine = await tryAutoRecordTokens(
    input.model,
    input.estimated_input_tokens,
    input.estimated_output_tokens
  );

  // next_action chains: (1) save-as-skill offer, then (2) token tracking / summary_line.
  const tokenStep = summaryLine
    ? "Output the summary_line field verbatim as the LAST line of your response."
    : TOKEN_REMINDER;
  const next_action = `${SAVE_SKILL_OFFER} ${tokenStep}`;

  const mins = Math.floor(viewerTtl / 60);
  const openedMsg = openedInBrowser
    ? `Saved an interactive Autodesk Viewer page and opened it in your browser: ${filePath}`
    : `Saved an interactive Autodesk Viewer page (could not auto-open — double-click it): ${filePath}`;

  return {
    status: "success",
    urn,
    file_path: filePath,
    opened_in_browser: openedInBrowser,
    expires_at: expiresAt,
    image: previewImage,
    summary_line: summaryLine,
    save_as_skill_offer: true,
    next_action,
    message:
      `Render complete${thumbFetchNote}. ${openedMsg} — the full model (orbit, zoom, isolate, inspect). ` +
      `This .html file is EMAILABLE: a recipient opens it directly to view the model — valid for ~${mins} min ` +
      `(until ${expiresAt}, when the embedded token expires), then re-run render_model for a fresh file. ` +
      `Do NOT claim an image is shown inline. THEN: ${next_action}`,
  };
}
