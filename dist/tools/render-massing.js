// render_massing (PROTOTYPE) — an in-panel, model-derived 3D massing viewer.
//
// Why this works in the artifact panel where the real APS Viewer can't:
//   • three.js loads from cdnjs.cloudflare.com — the ONE external script origin the artifact CSP
//     allows. (The APS Viewer SDK is on developer.api.autodesk.com → blocked.)
//   • The geometry is a COMPACT schematic built from the model's AEC Model Data (real levels +
//     real footprint from grid bounds) + category counts — a few KB, so it inlines into the
//     artifact without the relay corruption that killed big blobs.
//   • WebGL/canvas isn't CSP-gated; no external network at runtime (data is inlined).
//
// Source of truth = the Autodesk.AEC.ModelData derivative (AECModelData.json): real `levels`
// (name/elevation/height) and `grids` (boundingBox → plan footprint). That makes a true
// stacked-floor building massing of correct proportions, not a bar chart.
import { z } from "zod";
import { resolveCredential } from "../auth/credential-resolver.js";
const MD_BASE = "https://developer.api.autodesk.com/modelderivative/v2";
export const renderMassingSchema = z.object({
    oss_url: z
        .string()
        .regex(/^oss:\/\/[^/]+\/.+/, "Must be an oss:// URL in the form oss://bucketKey/objectKey")
        .describe("oss:// URL of a model ALREADY translated (run render_model first). Massing is built from " +
        "its AEC Model Data (levels + grid footprint) and category counts."),
});
function ossUrlToUrn(ossUrl) {
    return Buffer.from(`urn:adsk.objects:os.object:${ossUrl.replace(/^oss:\/\//, "")}`).toString("base64url");
}
async function apiFetch(url, token, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
function countLeaves(node) {
    if (!node.objects || node.objects.length === 0)
        return 1;
    return node.objects.reduce((s, c) => s + countLeaves(c), 0);
}
// ── Handler ─────────────────────────────────────────────────────────────────
export async function handleRenderMassing(input) {
    const urn = ossUrlToUrn(input.oss_url);
    let token;
    try {
        token = (await resolveCredential(["data:read"])).access_token;
    }
    catch (err) {
        return { status: "error", error: `APS auth failed: ${String(err)}`, hint: "Run authenticate_aps first." };
    }
    // Manifest must be translated.
    const man = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest`, token);
    if (man.status === 404) {
        return { status: "error", error: "Model not translated yet.", hint: "Run render_model on this file first." };
    }
    const manJson = await man.json().catch(() => ({}));
    if (manJson.status !== "success") {
        return { status: "pending", urn, message: `Translation ${manJson.status ?? "?"} — wait, then retry render_massing.` };
    }
    // ── AEC Model Data → real levels + grid footprint ──
    let levels = [];
    let footprint = { w: 60, d: 45 }; // nominal fallback
    let modelName = input.oss_url.split("/").pop() ?? "Model";
    try {
        // locate the AECModelData.json derivative
        let aecUrn = null;
        const walk = (ds) => (ds || []).forEach((d) => {
            if (typeof d.urn === "string" && /AECModelData\.json$/i.test(d.urn))
                aecUrn = d.urn;
            if (d.children)
                walk(d.children);
        });
        walk(manJson.derivatives);
        if (!aecUrn)
            aecUrn = `urn:adsk.viewing:fs.file:${urn}/output/Resource/AECModelData.json`;
        const aecRes = await apiFetch(`${MD_BASE}/designdata/${urn}/manifest/${encodeURIComponent(aecUrn)}`, token, 45_000);
        if (aecRes.ok) {
            const aec = await aecRes.json();
            levels = (aec.levels ?? [])
                .filter((l) => typeof l.elevation === "number")
                .map((l) => {
                // Revit uses INT_MAX (2147483647) as an "unbounded" sentinel for the top level's height;
                // any out-of-range value would blow up the vertical scale. Treat as 0 → the viewer falls
                // back to the elevation gap to the next level.
                const h = Number(l.height);
                const height = Number.isFinite(h) && h > 0 && h < 10000 ? h : 0;
                return { name: String(l.name ?? "Level"), elevation: l.elevation, height };
            })
                .sort((a, b) => a.elevation - b.elevation)
                .slice(0, 40);
            // footprint = union of grid bounding boxes in plan (X = idx 0/3, Y = idx 1/4)
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const g of aec.grids ?? []) {
                const bb = g.boundingBox;
                if (Array.isArray(bb) && bb.length >= 6) {
                    minX = Math.min(minX, bb[0], bb[3]);
                    maxX = Math.max(maxX, bb[0], bb[3]);
                    minY = Math.min(minY, bb[1], bb[4]);
                    maxY = Math.max(maxY, bb[1], bb[4]);
                }
            }
            if (isFinite(minX) && maxX > minX && maxY > minY) {
                footprint = { w: maxX - minX, d: maxY - minY };
            }
        }
    }
    catch {
        /* AEC optional — viewer falls back to category towers if levels empty */
    }
    // ── Object tree → category element counts (for the legend / fallback towers) ──
    let categories = [];
    try {
        const metaRes = await apiFetch(`${MD_BASE}/designdata/${urn}/metadata`, token);
        const metaJson = await metaRes.json().catch(() => ({}));
        const views = metaJson?.data?.metadata ?? [];
        const guid = (views.find((v) => v.role === "3d") ?? views[0])?.guid;
        if (guid) {
            const treeRes = await apiFetch(`${MD_BASE}/designdata/${urn}/metadata/${guid}`, token);
            if (treeRes.status === 202 && levels.length === 0) {
                return { status: "pending", urn, message: "Model Derivative is still preparing metadata — retry render_massing in ~15s." };
            }
            const treeJson = await treeRes.json().catch(() => ({}));
            const root = (treeJson?.data?.objects ?? [])[0];
            if (root?.name)
                modelName = root.name;
            const catNodes = root?.objects ?? [];
            categories = catNodes
                .map((c) => ({ name: String(c.name ?? "?"), count: countLeaves(c) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 12);
        }
    }
    catch {
        /* categories optional */
    }
    const totalElements = categories.reduce((s, c) => s + c.count, 0);
    const massing = { name: modelName, footprint, levels, categories, totalElements };
    const artifactHtml = buildMassingHtml(massing);
    return {
        status: "success",
        urn,
        artifact_html: artifactHtml,
        massing,
        message: `Massing extracted (${levels.length} levels, footprint ${footprint.w.toFixed(0)}×${footprint.d.toFixed(0)}, ` +
            `${categories.length} categories, ${totalElements} elements). ` +
            `Present artifact_html VERBATIM as an HTML artifact titled "Model Massing" (type text/html). ` +
            `It is small structured HTML (no base64) — reproduce it exactly. It loads three.js from cdnjs ` +
            `(allowed by the artifact CSP) and renders the building's real floors as a stacked massing you ` +
            `orbit/zoom — in the panel. If you see a red "three.js blocked" message, the host CSP refused ` +
            `cdnjs; tell the user and fall back to render_model's browser viewer.`,
    };
}
// ── Artifact (three.js massing viewer, self-contained, cdnjs only) ───────────
function buildMassingHtml(m) {
    const data = JSON.stringify(m).replace(/</g, "\\u003c");
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
            border-radius:10px; padding:12px 14px; max-width:250px; backdrop-filter:blur(6px); }
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
    fail('three.js was blocked from loading (cdnjs not permitted by this host CSP). The massing viewer cannot run here.');
    return;
  }

  var lg = document.getElementById('legend');
  var hasFloors = M.levels && M.levels.length >= 2;
  var cats = (M.categories||[]).slice(0,8).map(function(c){ return '<div class="row"><span>'+c.name+'</span><span>'+c.count+'</span></div>'; }).join('');
  var sub = hasFloors ? (M.levels.length+' levels · '+M.totalElements+' elements')
                      : ('composition · '+M.totalElements+' elements across '+(M.categories||[]).length+' categories');
  lg.innerHTML = '<h1>'+M.name+'</h1><div class="sub">'+sub+'</div>'+cats;

  var canvas = document.getElementById('c');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  var scene = new THREE.Scene(); scene.background = new THREE.Color(0x15161a);
  var camera = new THREE.PerspectiveCamera(45, 1, 0.1, 8000);
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  var dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(1,2,1.5); scene.add(dir);
  var group = new THREE.Group(); scene.add(group);

  function addBox(w,h,d,x,y,z,color,opacity){
    var mesh = new THREE.Mesh(new THREE.BoxGeometry(w,h,d),
      new THREE.MeshLambertMaterial({ color: color, transparent: opacity<1, opacity: opacity }));
    mesh.position.set(x,y,z); group.add(mesh);
    var edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w,h,d)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.22 }));
    edges.position.set(x,y,z); group.add(edges);
  }

  if (hasFloors) {
    // ── Real building massing: stacked floors (footprint × floor height) at true elevations ──
    var lv = M.levels;
    var minE = lv[0].elevation;
    var top = lv[lv.length-1].elevation + (lv[lv.length-1].height || 0);
    var bH = top - minE;
    if (!isFinite(bH) || bH <= 0 || bH > 100000) bH = (lv[lv.length-1].elevation - minE) || 1; // guard bad data
    var W = M.footprint.w || 60, D = M.footprint.d || 45;
    var scale = 80 / Math.max(W, D, bH);
    for (var i=0;i<lv.length;i++){
      var h = (lv[i].height && lv[i].height>0 ? lv[i].height
              : (i<lv.length-1 ? lv[i+1].elevation-lv[i].elevation : bH/lv.length)) * scale;
      h = Math.max(h, 0.5);
      var base = (lv[i].elevation - minE) * scale;
      var t = i/Math.max(1,lv.length-1);
      var col = new THREE.Color().setHSL(0.58 - 0.45*t, 0.55, 0.55);
      addBox(W*scale, h, D*scale, 0, base + h/2, 0, col, 0.55);
    }
    group.position.y = -(bH*scale)/2;
  } else {
    // ── Fallback: per-category towers (height ∝ log count) ──
    var c2 = (M.categories||[]).slice(0,10);
    var maxC = Math.max.apply(null, c2.map(function(c){return c.count;}).concat([1]));
    var bw=8, gap=4, total=c2.length*(bw+gap)-gap;
    c2.forEach(function(c,i){
      var hh = 6 + (Math.log(c.count+1)/Math.log(maxC+1))*54;
      addBox(bw, hh, bw, i*(bw+gap)-total/2+bw/2, hh/2, 0, new THREE.Color().setHSL((i/Math.max(1,c2.length))*0.7,0.55,0.55), 0.9);
    });
    addBox(total+8, 0.6, bw+8, 0, -0.3, 0, 0x2a2c34, 1);
    group.position.y = -25;
  }

  var dist = 150;
  function resize(){ var w=window.innerWidth,h=window.innerHeight; renderer.setSize(w,h,false); camera.aspect=w/h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', resize); resize();

  var az=0.7, el=0.45, down=false, px=0, py=0;
  canvas.addEventListener('mousedown', function(e){ down=true; px=e.clientX; py=e.clientY; });
  window.addEventListener('mouseup', function(){ down=false; });
  window.addEventListener('mousemove', function(e){ if(!down)return; az-=(e.clientX-px)*0.01; el+=(e.clientY-py)*0.01; el=Math.max(0.05,Math.min(1.5,el)); px=e.clientX; py=e.clientY; });
  canvas.addEventListener('wheel', function(e){ dist*=(1+(e.deltaY>0?0.1:-0.1)); dist=Math.max(50,Math.min(500,dist)); e.preventDefault(); }, {passive:false});

  function frame(){
    requestAnimationFrame(frame);
    if (!down) az += 0.0015;
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
