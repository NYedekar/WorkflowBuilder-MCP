// render_massing (PROTOTYPE) — an in-panel, model-derived 3D massing viewer.
//
// Why this can work in the artifact panel where the real viewer can't:
//   • three.js loads from cdnjs.cloudflare.com — the ONE external script origin the artifact CSP
//     allows. (The APS Viewer SDK is on developer.api.autodesk.com → blocked.)
//   • The geometry is NOT the heavy SVF2 — it's a COMPACT schematic (levels + category counts),
//     a few KB, so it inlines into the artifact without the relay-corruption that killed big blobs.
//   • WebGL/canvas isn't CSP-gated. No external network at runtime (data is inlined).
// This also definitively tests whether cdnjs scripts run in the artifact sandbox in this host.

import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";

const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";

export const renderMassingSchema = z.object({
  oss_url: z
    .string()
    .regex(/^oss:\/\/[^/]+\/.+/, "Must be an oss:// URL in the form oss://bucketKey/objectKey")
    .describe(
      "oss:// URL of a model ALREADY translated (run render_model first). Massing is built from " +
        "its Model Derivative metadata (levels + category counts)."
    ),
});

export type RenderMassingInput = z.infer<typeof renderMassingSchema>;

export type RenderMassingOutput =
  | { status: "success"; urn: string; artifact_html: string; massing: MassingData; message: string }
  | { status: "pending"; urn: string; message: string }
  | { status: "error"; error: string; hint?: string };

interface MassingData {
  name: string;
  levels: { name: string; elevation: number }[]; // elevation in model units, sorted asc
  categories: { name: string; count: number }[]; // top categories by element count
  totalElements: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function ossUrlToUrn(ossUrl: string): string {
  return Buffer.from(`urn:adsk.objects:os.object:${ossUrl.replace(/^oss:\/\//, "")}`).toString("base64url");
}

async function apiFetch(url: string, token: string, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Recursively count leaf objects under a tree node.
function countLeaves(node: any): number {
  if (!node.objects || node.objects.length === 0) return 1;
  return node.objects.reduce((s: number, c: any) => s + countLeaves(c), 0);
}

// Find a numeric "Elevation" anywhere in a properties object (Revit nests it under groups).
function findElevation(props: any): number | null {
  if (!props || typeof props !== "object") return null;
  for (const [k, v] of Object.entries(props)) {
    if (/^elevation$/i.test(k) && typeof v === "number") return v;
    if (v && typeof v === "object") {
      const nested = findElevation(v);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function handleRenderMassing(input: RenderMassingInput): Promise<RenderMassingOutput> {
  const urn = ossUrlToUrn(input.oss_url);

  let token: string;
  try {
    token = (await resolveCredential(["data:read"])).access_token;
  } catch (err) {
    return { status: "error", error: `APS auth failed: ${String(err)}`, hint: "Run authenticate_aps first." };
  }

  // Manifest must be translated (metadata derives from it).
  const man = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest`, token);
  if (man.status === 404) {
    return { status: "error", error: "Model not translated yet.", hint: "Run render_model on this file first." };
  }
  const manJson: any = await man.json().catch(() => ({}));
  if (manJson.status !== "success") {
    return { status: "pending", urn, message: `Translation ${manJson.status ?? "?"} — wait, then retry render_massing.` };
  }

  // 1) metadata → a 3D view guid
  const metaRes = await apiFetch(`${MD_BASE}/designdata/${urn}/metadata`, token);
  const metaJson: any = await metaRes.json().catch(() => ({}));
  const views: any[] = metaJson?.data?.metadata ?? [];
  const view = views.find((v) => v.role === "3d") ?? views[0];
  if (!view?.guid) {
    return { status: "error", error: "No model views found in metadata.", hint: "Re-run render_model to (re)translate." };
  }
  const guid = view.guid;

  // 2) object tree → top categories + counts
  let categories: { name: string; count: number }[] = [];
  let modelName = input.oss_url.split("/").pop() ?? "Model";
  try {
    const treeRes = await apiFetch(`${MD_BASE}/designdata/${urn}/metadata/${guid}`, token);
    if (treeRes.status === 202) {
      return { status: "pending", urn, message: "Model Derivative is still preparing metadata — retry render_massing in ~15s." };
    }
    const treeJson: any = await treeRes.json().catch(() => ({}));
    const roots: any[] = treeJson?.data?.objects ?? [];
    const root = roots[0];
    if (root?.name) modelName = root.name;
    const catNodes: any[] = root?.objects ?? roots;
    categories = catNodes
      .map((c) => ({ name: String(c.name ?? "?"), count: countLeaves(c) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  } catch {
    /* categories optional */
  }
  const totalElements = categories.reduce((s, c) => s + c.count, 0);

  // 3) properties → levels with elevations (best-effort)
  let levels: { name: string; elevation: number }[] = [];
  try {
    const propRes = await apiFetch(`${MD_BASE}/designdata/${urn}/metadata/${guid}/properties`, token, 60_000);
    if (propRes.ok) {
      const propJson: any = await propRes.json().catch(() => ({}));
      const coll: any[] = propJson?.data?.collection ?? [];
      const byName = new Map<string, number>();
      for (const obj of coll) {
        const nm = String(obj.name ?? "");
        // Levels are named like "Level 1", "Roof", "T.O. ...", and carry an Elevation.
        if (!/level|roof|floor|grade|storey|story|t\.o\./i.test(nm)) continue;
        const elev = findElevation(obj.properties);
        if (elev !== null && !byName.has(nm)) byName.set(nm, elev);
      }
      levels = [...byName.entries()]
        .map(([name, elevation]) => ({ name, elevation }))
        .sort((a, b) => a.elevation - b.elevation)
        .slice(0, 30);
    }
  } catch {
    /* levels optional — viewer falls back to a single massing block */
  }

  const massing: MassingData = { name: modelName, levels, categories, totalElements };
  const artifactHtml = buildMassingHtml(massing);

  return {
    status: "success",
    urn,
    artifact_html: artifactHtml,
    massing,
    message:
      `Massing extracted (${levels.length} levels, ${categories.length} categories, ${totalElements} elements). ` +
      `Present artifact_html VERBATIM as an HTML artifact titled "Model Massing" (type text/html). ` +
      `It is small structured HTML (no base64) — reproduce it exactly. It loads three.js from cdnjs ` +
      `(allowed by the artifact CSP) and renders the model's levels as stacked floors you can orbit/zoom — ` +
      `right in the panel. If the panel shows a red "three.js blocked" message, the host's CSP refused cdnjs; ` +
      `tell the user and fall back to render_model's browser viewer.`,
  };
}

// ── Artifact (three.js massing viewer, self-contained, cdnjs only) ───────────

function buildMassingHtml(m: MassingData): string {
  const data = JSON.stringify(m).replace(/</g, "\\u003c"); // safe inline
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { height:100%; }
  body { background:#15161a; color:#e8e8ea; font:13px -apple-system,system-ui,sans-serif; overflow:hidden; }
  #c { display:block; width:100vw; height:100vh; }
  #legend { position:fixed; top:12px; left:12px; background:#1f2026cc; border:1px solid #34353c;
            border-radius:10px; padding:12px 14px; max-width:240px; backdrop-filter:blur(6px); }
  #legend h1 { font-size:13px; margin-bottom:6px; }
  #legend .sub { opacity:.6; font-size:11px; margin-bottom:8px; }
  #legend .row { display:flex; justify-content:space-between; gap:10px; font-size:11px; padding:1px 0; }
  #legend .row span:last-child { opacity:.7; }
  #hint { position:fixed; bottom:10px; left:12px; opacity:.45; font-size:11px; }
  #err { position:fixed; inset:0; display:none; align-items:center; justify-content:center; text-align:center;
         padding:30px; color:#ff9a9a; background:#15161a; font-size:13px; }
</style>
</head>
<body>
  <canvas id="c"></canvas>
  <div id="legend"></div>
  <div id="hint">drag to orbit · scroll to zoom</div>
  <div id="err"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
(function () {
  var M = ${data};
  function fail(msg){ var e=document.getElementById('err'); e.style.display='flex'; e.textContent=msg; }
  if (typeof THREE === 'undefined') {
    fail('three.js was blocked from loading (cdnjs not permitted by this host\\'s CSP). The massing viewer cannot run here.');
    return;
  }

  // Build legend
  var lg = document.getElementById('legend');
  var cats = (M.categories||[]).slice(0,8).map(function(c){ return '<div class="row"><span>'+c.name+'</span><span>'+c.count+'</span></div>'; }).join('');
  var sub = (M.levels && M.levels.length>=2)
    ? (M.levels.length+' levels · '+M.totalElements+' elements')
    : ('composition · '+M.totalElements+' elements across '+(M.categories||[]).length+' categories');
  lg.innerHTML = '<h1>'+M.name+'</h1><div class="sub">'+sub+'</div>'+cats;

  var canvas = document.getElementById('c');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15161a);
  var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  var dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(1,2,1); scene.add(dir);

  var group = new THREE.Group(); scene.add(group);

  function addBox(w,h,d,x,y,z,color,opacity){
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),
      new THREE.MeshLambertMaterial({ color: color, transparent: opacity<1, opacity: opacity }));
    mesh.position.set(x,y,z); group.add(mesh);
    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w,h,d)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.18 }));
    edges.position.set(x,y,z); group.add(edges);
    return mesh;
  }

  if (M.levels && M.levels.length >= 2) {
    // ── Real massing: stacked floor slabs at true elevations ──
    var FW=40, FD=30, lv=M.levels;
    var elevs=lv.map(function(l){return l.elevation;});
    var minE=Math.min.apply(null,elevs), maxE=Math.max.apply(null,elevs), span=(maxE-minE)||1, H=60;
    lv.forEach(function(l,i){
      var t=i/(lv.length-1);
      addBox(FW,1.2,FD, 0, ((l.elevation-minE)/span)*H, 0, new THREE.Color().setHSL(0.58-0.12*t,0.55,0.55), 0.85);
    });
    group.position.y = -H/2;
  } else {
    // ── Composition towers: one tower per category, height ∝ element count (log) ──
    var cats=(M.categories||[]).slice(0,10);
    var maxC=Math.max.apply(null, cats.map(function(c){return c.count;}).concat([1]));
    var bw=8, gap=4, total=cats.length*(bw+gap)-gap;
    cats.forEach(function(c,i){
      var h = 6 + (Math.log(c.count+1)/Math.log(maxC+1))*54; // 6..60
      var x = i*(bw+gap) - total/2 + bw/2;
      var col = new THREE.Color().setHSL((i/Math.max(1,cats.length))*0.7, 0.55, 0.55);
      addBox(bw, h, bw, x, h/2, 0, col, 0.9);
    });
    // ground plate
    addBox(total+8, 0.6, bw+8, 0, -0.3, 0, 0x2a2c34, 1);
    group.position.y = -25;
  }

  var dist = 120;
  function resize(){ var w=window.innerWidth,h=window.innerHeight; renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', resize); resize();

  // minimal orbit (no OrbitControls — not on cdnjs)
  var az = 0.7, el = 0.5, down=false, px=0, py=0;
  canvas.addEventListener('mousedown', function(e){ down=true; px=e.clientX; py=e.clientY; });
  window.addEventListener('mouseup', function(){ down=false; });
  window.addEventListener('mousemove', function(e){ if(!down)return; az -= (e.clientX-px)*0.01; el += (e.clientY-py)*0.01; el=Math.max(0.05,Math.min(1.5,el)); px=e.clientX; py=e.clientY; });
  canvas.addEventListener('wheel', function(e){ dist *= (1 + (e.deltaY>0?0.1:-0.1)); dist=Math.max(40,Math.min(400,dist)); e.preventDefault(); }, {passive:false});

  function frame(){
    requestAnimationFrame(frame);
    if (!down) az += 0.0015; // gentle auto-spin
    camera.position.set(Math.sin(az)*Math.cos(el)*dist, Math.sin(el)*dist, Math.cos(az)*Math.cos(el)*dist);
    camera.lookAt(0,0,0);
    renderer.render(scene, camera);
  }
  frame();
})();
</script>
</body>
</html>`;
}
