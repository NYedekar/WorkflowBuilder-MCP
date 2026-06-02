// MCP Apps UI (experimental, Phase 4) — a "Save as skill" button rendered in-conversation.
//
// Uses the io.modelcontextprotocol/ui extension (MCP Apps, SEP-1865). Flow:
//   • offer_save_skill_button tool is linked to this UI resource via _meta.ui.resourceUri.
//   • When the tool runs, the host renders this HTML in a sandboxed iframe and delivers the
//     tool's structuredContent via a `ui/notifications/tool-result` postMessage.
//   • The iframe prefills the recipe and, on button click, calls back the real
//     save_workflow_as_skill tool via JSON-RPC `tools/call` over postMessage.
// Host support is negotiated; this is additive and inert on hosts that don't support MCP Apps.
export const SAVE_SKILL_UI_URI = "ui://workflow-builder/save-skill";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const SAVE_SKILL_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 -apple-system, system-ui, sans-serif; margin: 0; padding: 14px; }
  .card { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; padding: 16px; max-width: 460px; }
  .title { font-weight: 600; margin-bottom: 4px; }
  .sub { opacity: .7; margin-bottom: 12px; }
  label { display: block; font-size: 12px; opacity: .7; margin: 8px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
  button { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 0; cursor: pointer; background: #2563eb; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .status { margin-top: 10px; font-size: 13px; min-height: 18px; }
  .ok { color: #16a34a; } .err { color: #dc2626; }
  .steps { font-size: 12px; opacity: .7; margin-top: 6px; }
</style>
</head>
<body>
  <div class="card">
    <div class="title">Save this workflow as a reusable skill</div>
    <div class="sub">Re-run it on any file later — same steps, your inputs.</div>
    <label for="name">Skill name</label>
    <input id="name" placeholder="e.g. DWG Layer Report" />
    <div class="steps" id="steps"></div>
    <div class="row">
      <button id="save" disabled>💾 Save as skill</button>
    </div>
    <div class="status" id="status">Waiting for workflow details…</div>
  </div>
<script>
  (function () {
    var recipe = null, rpcId = 1;
    var nameEl = document.getElementById('name');
    var saveEl = document.getElementById('save');
    var statusEl = document.getElementById('status');
    var stepsEl = document.getElementById('steps');

    function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = 'status' + (cls ? ' ' + cls : ''); }

    window.addEventListener('message', function (e) {
      var msg = e.data || {};
      // Receive the recipe the tool passed as structuredContent.
      if (msg.method === 'ui/notifications/tool-result' && msg.params && msg.params.structuredContent) {
        recipe = msg.params.structuredContent;
        if (recipe.name) nameEl.value = recipe.name;
        var n = (recipe.steps || []).length;
        stepsEl.textContent = n + ' step' + (n === 1 ? '' : 's') + (recipe.auth_mode ? ' · ' + recipe.auth_mode + ' auth' : '');
        saveEl.disabled = false;
        setStatus('Ready to save.');
      }
      // Response to our tools/call.
      if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
        if (msg.error) { setStatus('Save failed: ' + (msg.error.message || 'error'), 'err'); saveEl.disabled = false; }
        else { setStatus('Saved! Run it anytime by name, or /' + (recipe && recipe.slug_hint || ''), 'ok'); }
      }
    });

    saveEl.addEventListener('click', function () {
      if (!recipe) { setStatus('No workflow details received yet.', 'err'); return; }
      saveEl.disabled = true; setStatus('Saving…');
      window.parent.postMessage({
        jsonrpc: '2.0', id: rpcId++, method: 'tools/call',
        params: {
          name: 'save_workflow_as_skill',
          arguments: {
            name: nameEl.value || recipe.name,
            intent: recipe.intent,
            inputs: recipe.inputs || [],
            steps: recipe.steps || [],
            auth_mode: recipe.auth_mode || 'auto'
          }
        }
      }, '*');
    });

    // Signal readiness (some hosts replay the tool-result after this).
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/ready' }, '*');
  })();
</script>
</body>
</html>`;
