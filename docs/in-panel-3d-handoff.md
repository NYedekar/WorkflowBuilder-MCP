# In-Panel 3D Viewer — Engineering Handoff

**Goal:** render an Autodesk model (RVT/DWG → APS) *interactively inside Claude's right panel*.
**Status (2026-06-03):** Schematic massing works in-panel today; **full geometry in-panel requires the web build** (rationale below). Full interactive model works *today* in the browser via `render_model`.

---

## 1. What works today (Claude Desktop, stdio MCP)

| Tool | What it does | Where it renders |
|---|---|---|
| `render_model` (mode=viewer) | Translates to **SVF2**, **auto-opens** the full Autodesk Viewer in the system browser. Records token usage (like `get_result`), offers save-as-skill. | Browser tab (full BIM, materials, selection) |
| `render_model` (mode=thumbnail) | 400×400 rendered preview as an MCP image block | Chat tool-result |
| `render_massing` | Builds a **schematic** stacked-floor block model (real levels + footprint from AEC Model Data; category towers fallback) as a three.js artifact | **Right panel** ✅ |

`render_massing` proved the key fact: **a three.js artifact loading from cdnjs renders interactively in the Claude Desktop panel.**

---

## 2. The hard constraints (the CSP / channel map)

Claude artifacts run in the `www.claudeusercontent.com` sandbox. Verified CSP:
- `script-src` → only **cdnjs.cloudflare.com** (+ pyodide) for external scripts. The APS Viewer SDK is on `developer.api.autodesk.com` → **blocked**. three.js core **is** on cdnjs ✅ (but addons like GLTFLoader/OrbitControls are NOT — inline them).
- `connect-src` → effectively dead (pyodide only). **No fetch/XHR/WebSocket to OSS signed URLs, your server, or localhost.**
- `frame-src` → self only. No nested external/localhost iframes (live-viewer-in-iframe = black screen).
- `block-all-mixed-content` → kills `http://127.0.0.1`.
- `img-src` allows `data:` (but see relay ceiling).

**Two ways data reaches a Claude-rendered surface without an external fetch:**
1. **Inline in an artifact** — but the artifact is **relayed verbatim by the LLM**, which corrupts/truncates above **~10 KB** (a 200×200 base64 thumbnail already broke it; the panel even failed to open). Good only for tiny structured data (e.g. the ~6 KB massing JSON+code).
2. **MCP Apps UI resource document** (`resources/read`, mime `text/html;profile=mcp-app`) — **host-fetched, NOT LLM-relayed, no documented size limit.** This is the only channel that can carry a multi-MB GLB. **BUT** it does not render in Claude **Desktop** today — host bug **#165** (extension negotiated + resource fetched, but the iframe never paints; confirmed via MCP logs). Same bug broke the "Save as skill" button.

**Net:** Desktop can't show real geometry in-panel — inline relay can't carry a GLB, and the no-relay channel (#165) is broken there.

### Measured: decimation vs relay ceiling (racbasic OBJ probe, 2026-06-03)
Translated racbasic.rvt → OBJ (`objectIds:[-1]`, single file) = **29.6 MB, 257K verts, 414K tris**. Vertex-cluster decimation + int16-quantized indexed serialization:

| grid | triangles | base64 size | vs ~10 KB ceiling |
|---|---|---|---|
| G=16 | 626 | 7.1 KB | ✅ fits — but ~massing-level blob, not recognizable |
| G=24 | 1,158 | 13.4 KB | ✗ |
| G=40 | 2,057 | 24.8 KB | ✗ |
| G=64 | 3,166 | 39.2 KB | ✗ (~min for a recognizable house) |
| G=160 | 7,172 | 91.6 KB | ✗ |

**Conclusion:** only a 626-triangle blob fits the Desktop inline-relay ceiling — not a real building. A recognizable house needs ~3K+ tris ≈ 40 KB+ ≈ 4× over. Real geometry therefore requires the **Web resource channel** (no size limit), not Desktop inline relay. (OBJ note: RVT→OBJ requires `advanced.modelGuid` + `objectIds:[-1]`; raw OBJ is huge — decimate with vertex clustering or gltf-transform/meshoptimizer + Draco.)

---

## 3. The web path (unblocks real geometry in-panel)

On **Claude Web**, bug #165 is reported not to apply (web/1P renders MCP Apps). So the **resource channel** becomes usable: serve a three.js + **inlined GLB** HTML document via `resources/read` — host-fetched, no relay, no 10 KB ceiling → real geometry in a three.js panel.

### SVF→glTF pipeline (server-side, the new work)
Model Derivative does **not** output glTF natively. Steps:
1. Translate to **classic SVF** (NOT SVF2 — SVF2 is streaming-only, not downloadable).
2. Download the SVF derivatives (manifest → derivative download endpoints).
3. Convert **SVF → glTF/GLB** with **`svf-utils`** (formerly `forge-convert-utils`, Petr Broz, npm).
4. **Decimate + Draco-compress** (raw building GLB is 50–200 MB → target a few MB; even on Web, inline size + perf matter).
5. Emit an MCP Apps UI resource: inline three.js (cdnjs or inline) + inline GLTFLoader/OrbitControls + the GLB as a `data:`/base64 blob in the resource HTML. Drive iframe height via `document.documentElement.style.height` (Claude ignores `ui/notifications/size-changed`).

### Transport
The MCP must be reachable remotely on Web (not local stdio). Start from the **`feat/streamable-http-transport`** branch (Streamable-HTTP transport on `/mcp`). Web conversion is a **pivot, not a port**: also need per-user 3LO auth (no shared 2LO), no local-file input (OSS upload / ACC-native), and hosting/ops.

### Validation harness (already in repo)
`render_viewer_poc` → `ui://workflow-builder/viewer-poc` renders a WebGL cube via the MCP Apps resource channel. On Desktop it shows blank (#165). **Run it first on Web** to confirm MCP Apps UI renders there before building the SVF→glTF pipeline.

---

## 4. Product tradeoff (carry forward)
- **three.js + glTF in-panel:** lightweight visual; **loses BIM data** (element IDs, parameters, selection) and clean Revit→PBR material mapping.
- **APS Viewer in browser (`render_model` today):** full BIM, materials, selection, properties — heavier, opens a browser tab.

So even after the web build, it's "lightweight in-panel visual" **vs** "full review in browser," not a replacement.

---

## 5. Open external bugs / risks
- **claude-ai-mcp #165** — MCP Apps UI iframe never paints in Claude Desktop (the blocker for Desktop in-panel).
- **#40** — Claude ignores declared `_meta.ui.csp` (`connectDomains`/`frameDomains`); CSP is partially hardcoded. So don't rely on `fetch()` from the iframe even on Web — inline the geometry.
- **#69** — `ui/notifications/size-changed` ignored; set DOM height directly.
- **#236** — MCP Apps iframes don't render in Cowork 3P deployment mode.

## 6. Code pointers
- `src/tools/render-model.ts` — SVF2 + auto-open browser viewer + token + skill offer.
- `src/tools/render-massing.ts` — in-panel schematic massing (three.js/cdnjs; AEC Model Data extraction).
- `src/lib/viewer-server.ts` — disk-backed local HTTP server (serves the browser viewer; `/v/<id>` + `/img/<id>.png`).
- `src/lib/viewer-poc-ui.ts` + `src/tools/render-viewer-poc.ts` — MCP Apps UI cube POC (the #165 / web-render test).
- `src/index.ts` — tool + resource wiring; `ReadResource` serves the UI resources.
- Memory: `feedback_claude_artifact_csp.md` (full CSP/channel map + findings).
