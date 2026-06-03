// Proof-of-concept MCP Apps UI resource: a rotating WebGL cube rendered INLINE in the
// conversation. Purpose: validate that the relay-free channel works in this Claude Desktop —
// the host fetches this HTML via resources/read (the LLM never relays it), so we can inline
// arbitrary JS/data here. If this cube renders + spins + sizes correctly, the same channel
// can carry an inlined three.js bundle + GLB for the real model viewer (Phase 2).
//
// Key constraints baked in (from MCP Apps research, 2026-06-03):
//   • CSP: script-src 'self' 'unsafe-inline' (no eval) — raw WebGL needs neither. WebGL OK.
//   • Claude IGNORES ui/notifications/size-changed — we set documentElement.style.height directly.
//   • structuredContent arrives via ui/notifications/tool-result postMessage (relay-free, ≤~112KB).

export const VIEWER_POC_URI = "ui://workflow-builder/viewer-poc";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

export const VIEWER_POC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; }
  #app { height: 520px; background: radial-gradient(ellipse at center, #2c2c34 0%, #16161a 100%);
         position: relative; overflow: hidden; font: 13px -apple-system, system-ui, sans-serif; color: #e8e8ea; }
  #gl { display: block; width: 100%; height: 100%; }
  #hud { position: absolute; top: 12px; left: 14px; right: 14px; display: flex; justify-content: space-between;
         pointer-events: none; }
  #title { font-weight: 600; }
  #status { opacity: .7; }
  #err { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
         text-align: center; padding: 24px; color: #f88; }
</style>
</head>
<body>
  <div id="app">
    <canvas id="gl"></canvas>
    <div id="hud"><span id="title">WebGL POC · MCP Apps inline render</span><span id="status">starting…</span></div>
    <div id="err"></div>
  </div>
<script>
(function () {
  // Force a fixed iframe height — Claude ignores the spec size-changed notification and instead
  // reads documentElement height directly from the DOM.
  document.documentElement.style.height = "520px";

  var statusEl = document.getElementById("status");
  var titleEl = document.getElementById("title");
  function setStatus(s) { statusEl.textContent = s; }
  function fail(m) { var e = document.getElementById("err"); e.style.display = "flex"; e.textContent = m; setStatus("error"); }

  // Receive structuredContent (relay-free) — lets us prove that channel too (e.g. a label/tint).
  window.addEventListener("message", function (ev) {
    var msg = ev.data || {};
    if (msg.method === "ui/notifications/tool-result" && msg.params && msg.params.structuredContent) {
      var sc = msg.params.structuredContent;
      if (sc.title) titleEl.textContent = sc.title;
    }
  });
  // Announce readiness so the host (re)delivers the tool result.
  try { window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/ready" }, "*"); } catch (e) {}

  var canvas = document.getElementById("gl");
  var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  if (!gl) { fail("WebGL not available in this iframe."); return; }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  // ── minimal mat4 ──
  function ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  function mul(a, b) {
    var o = new Array(16);
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
      o[r*4+c] = a[r*4+0]*b[0*4+c] + a[r*4+1]*b[1*4+c] + a[r*4+2]*b[2*4+c] + a[r*4+3]*b[3*4+c];
    }
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
  }
  function translate(m, x, y, z) { return mul(m, [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]); }
  function rotY(m, a) { var c=Math.cos(a),s=Math.sin(a); return mul(m, [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); }
  function rotX(m, a) { var c=Math.cos(a),s=Math.sin(a); return mul(m, [1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); }

  // ── cube geometry: 6 faces × 4 verts, per-face color ──
  var positions = [
    -1,-1, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1,   // +z
    -1,-1,-1, -1, 1,-1,  1, 1,-1,  1,-1,-1,   // -z
    -1, 1,-1, -1, 1, 1,  1, 1, 1,  1, 1,-1,   // +y
    -1,-1,-1,  1,-1,-1,  1,-1, 1, -1,-1, 1,   // -y
     1,-1,-1,  1, 1,-1,  1, 1, 1,  1,-1, 1,   // +x
    -1,-1,-1, -1,-1, 1, -1, 1, 1, -1, 1,-1    // -x
  ];
  var faceColors = [[0.40,0.62,1.0],[0.25,0.42,0.75],[0.55,0.75,1.0],[0.20,0.34,0.6],[0.46,0.68,1.0],[0.30,0.5,0.85]];
  var colors = [];
  for (var f = 0; f < 6; f++) for (var v = 0; v < 4; v++) colors.push(faceColors[f][0], faceColors[f][1], faceColors[f][2]);
  var indices = [];
  for (var i = 0; i < 6; i++) { var b = i*4; indices.push(b,b+1,b+2, b,b+2,b+3); }

  function buf(data, type) { var b = gl.createBuffer(); gl.bindBuffer(type, b); gl.bufferData(type, data, gl.STATIC_DRAW); return b; }
  var posBuf = buf(new Float32Array(positions), gl.ARRAY_BUFFER);
  var colBuf = buf(new Float32Array(colors), gl.ARRAY_BUFFER);
  var idxBuf = buf(new Uint16Array(indices), gl.ELEMENT_ARRAY_BUFFER);

  var vsrc = "attribute vec3 p; attribute vec3 c; uniform mat4 mvp; varying vec3 vc;" +
             "void main(){ gl_Position = mvp * vec4(p,1.0); vc = c; }";
  var fsrc = "precision mediump float; varying vec3 vc; void main(){ gl_FragColor = vec4(vc,1.0); }";
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { fail("shader: " + gl.getShaderInfoLog(s)); }
    return s; }
  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { fail("link: " + gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  var aP = gl.getAttribLocation(prog, "p"), aC = gl.getAttribLocation(prog, "c"), uMVP = gl.getUniformLocation(prog, "mvp");

  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  var t0 = null, frames = 0;
  function frame(t) {
    if (t0 === null) t0 = t;
    var dt = (t - t0) / 1000;
    var proj = perspective(45 * Math.PI / 180, canvas.width / canvas.height || 1, 0.1, 100);
    var mv = ident(); mv = translate(mv, 0, 0, -6); mv = rotY(mv, dt * 0.8); mv = rotX(mv, dt * 0.45);
    var mvp = mul(proj, mv);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf); gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.uniformMatrix4fv(uMVP, false, new Float32Array(mvp));
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);

    if (++frames === 3) setStatus("rendering ✓");
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;
