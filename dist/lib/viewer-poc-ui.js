// Proof-of-concept MCP Apps UI resource — DIAGNOSTIC build.
//
// First POC rendered a BLANK WHITE box (iframe mounted via host chrome, but content didn't paint).
// White + my dark theme being invisible suggested either (a) the HTML isn't loading into the iframe,
// or (b) the <style>/<script> aren't taking effect. This build separates those with three
// INDEPENDENT signals, each using ONLY inline styles (no reliance on the <style> block or JS to be
// visible):
//   1. GREEN static banner  → the resource HTML loaded into the iframe at all.
//   2. #jsmark turns green   → inline <script> executes (CSP allows 'unsafe-inline').
//   3. Cube paints           → WebGL works in the sandbox.
// Whatever we see in the next screenshot pinpoints the exact failure layer.
export const VIEWER_POC_URI = "ui://workflow-builder/viewer-poc";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const VIEWER_POC_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#16161a;font-family:-apple-system,system-ui,sans-serif">
  <!-- SIGNAL 1: pure static HTML + inline style. Visible even if CSS/JS are removed. -->
  <div style="background:#0a7d2c;color:#fff;font-weight:700;font-size:15px;padding:14px;text-align:center">
    &#9989; Signal 1: MCP App HTML loaded (static)
  </div>

  <!-- SIGNAL 2: starts red; inline code flips it green if JS runs. -->
  <div id="jsmark" style="background:#7a2d2d;color:#fff;font-weight:600;font-size:13px;padding:10px;text-align:center">
    &#9203; Signal 2: JS has not run yet
  </div>

  <!-- SIGNAL 3: WebGL cube. Opaque dark clear color so a working-but-empty canvas is still visible. -->
  <div style="position:relative;height:360px;background:#1b1b22">
    <canvas id="gl" width="600" height="360" style="display:block;width:100%;height:100%"></canvas>
    <div id="status" style="position:absolute;top:8px;left:10px;color:#cfd2e0;font-size:12px">Signal 3: starting WebGL…</div>
    <div id="err" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;color:#ff9a9a;font-size:13px;text-align:center;padding:20px"></div>
  </div>
<script>
(function () {
  // Force a fixed height — Claude ignores ui/notifications/size-changed; it reads documentElement height.
  document.documentElement.style.height = "740px";
  document.body.style.height = "740px";

  // Signal 2: prove inline JS executes.
  var jm = document.getElementById("jsmark");
  if (jm) { jm.style.background = "#0a7d2c"; jm.innerHTML = "&#9989; Signal 2: inline JS runs"; }

  var statusEl = document.getElementById("status");
  function setStatus(s) { if (statusEl) statusEl.textContent = "Signal 3: " + s; }
  function fail(m) { var e = document.getElementById("err"); if (e) { e.style.display = "flex"; e.textContent = "Signal 3 ERROR: " + m; } setStatus("error"); }

  // structuredContent (relay-free) + readiness handshake.
  window.addEventListener("message", function (ev) {
    var msg = ev.data || {};
    if (msg.method === "ui/notifications/tool-result" && msg.params && msg.params.structuredContent) {
      setStatus("got structuredContent ✓");
    }
  });
  try { window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/ready" }, "*"); } catch (e) {}

  var canvas = document.getElementById("gl");
  var gl = canvas && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
  if (!gl) { fail("WebGL context unavailable"); return; }

  function ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  function mul(a, b) { var o = new Array(16);
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++)
      o[r*4+c] = a[r*4]*b[c] + a[r*4+1]*b[4+c] + a[r*4+2]*b[8+c] + a[r*4+3]*b[12+c];
    return o; }
  function perspective(f0, aspect, near, far) { var f = 1/Math.tan(f0/2), nf = 1/(near-far);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]; }
  function translate(m,x,y,z){ return mul(m,[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]); }
  function rotY(m,a){ var c=Math.cos(a),s=Math.sin(a); return mul(m,[c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1]); }
  function rotX(m,a){ var c=Math.cos(a),s=Math.sin(a); return mul(m,[1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1]); }

  var positions = [
    -1,-1, 1, 1,-1, 1, 1, 1, 1, -1, 1, 1,
    -1,-1,-1, -1, 1,-1, 1, 1,-1, 1,-1,-1,
    -1, 1,-1, -1, 1, 1, 1, 1, 1, 1, 1,-1,
    -1,-1,-1, 1,-1,-1, 1,-1, 1, -1,-1, 1,
     1,-1,-1, 1, 1,-1, 1, 1, 1, 1,-1, 1,
    -1,-1,-1, -1,-1, 1, -1, 1, 1, -1, 1,-1
  ];
  var fc = [[0.40,0.62,1.0],[0.25,0.42,0.75],[0.55,0.75,1.0],[0.20,0.34,0.6],[0.46,0.68,1.0],[0.30,0.5,0.85]];
  var colors = [];
  for (var f=0;f<6;f++) for (var v=0;v<4;v++) colors.push(fc[f][0],fc[f][1],fc[f][2]);
  var indices = []; for (var i=0;i<6;i++){ var b=i*4; indices.push(b,b+1,b+2,b,b+2,b+3); }

  function mkbuf(d,t){ var b=gl.createBuffer(); gl.bindBuffer(t,b); gl.bufferData(t,d,gl.STATIC_DRAW); return b; }
  var posBuf = mkbuf(new Float32Array(positions), gl.ARRAY_BUFFER);
  var colBuf = mkbuf(new Float32Array(colors), gl.ARRAY_BUFFER);
  var idxBuf = mkbuf(new Uint16Array(indices), gl.ELEMENT_ARRAY_BUFFER);

  var vsrc = "attribute vec3 p; attribute vec3 c; uniform mat4 mvp; varying vec3 vc; void main(){ gl_Position = mvp*vec4(p,1.0); vc=c; }";
  var fsrc = "precision mediump float; varying vec3 vc; void main(){ gl_FragColor = vec4(vc,1.0); }";
  function sh(t,s){ var o=gl.createShader(t); gl.shaderSource(o,s); gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)){ fail("shader "+gl.getShaderInfoLog(o)); } return o; }
  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){ fail("link "+gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);
  var aP = gl.getAttribLocation(prog,"p"), aC = gl.getAttribLocation(prog,"c"), uMVP = gl.getUniformLocation(prog,"mvp");
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.105, 0.105, 0.133, 1.0); // opaque — empty canvas still visibly dark

  var t0 = null, frames = 0;
  function frame(t){
    if (t0===null) t0=t;
    var dt=(t-t0)/1000;
    var proj = perspective(45*Math.PI/180, (canvas.width/canvas.height)||1.6, 0.1, 100);
    var mv = translate(ident(),0,0,-6); mv = rotY(mv, dt*0.8); mv = rotX(mv, dt*0.45);
    var mvp = mul(proj, mv);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER,posBuf); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ARRAY_BUFFER,colBuf); gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC,3,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,idxBuf);
    gl.uniformMatrix4fv(uMVP, false, new Float32Array(mvp));
    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);
    if (++frames === 3) setStatus("rendering cube ✓");
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
</script>
</body>
</html>`;
