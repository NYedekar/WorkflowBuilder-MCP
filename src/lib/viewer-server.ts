import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";

const PORT = 7830;

const STORE_DIR = path.join(os.tmpdir(), "aps-mcp-viewers");
const MAX_AGE_MS = 60 * 60 * 1000;

// Pending viewer-update store: { oss_url, changes[] } posted by the viewer HTML, consumed by apply_viewer_updates.
const PENDING_DIR = path.join(os.tmpdir(), "aps-mcp-pending");
function ensurePendingDir() { try { fs.mkdirSync(PENDING_DIR, { recursive: true }); } catch { /* exists */ } }
function pendingFile(id: string) { return path.join(PENDING_DIR, `${id}.json`); }
function statusFile(id: string)  { return path.join(PENDING_DIR, `${id}.status.json`); }

export interface PendingChange { elementId: string; elementName?: string; parameter: string; value: string; }
export interface PendingPayload { session_id: string; oss_url: string; changes: PendingChange[]; submitted_at: string; }
export interface PendingStatus  { status: "submitted" | "processing" | "done" | "failed"; new_file_path?: string; error?: string; updated_at: string; }

export function storePending(payload: PendingPayload): void {
  ensurePendingDir();
  fs.writeFileSync(pendingFile(payload.session_id), JSON.stringify(payload), "utf-8");
  fs.writeFileSync(statusFile(payload.session_id), JSON.stringify({ status: "submitted", updated_at: new Date().toISOString() }), "utf-8");
}

export function readPending(sessionId: string): PendingPayload | null {
  try { return JSON.parse(fs.readFileSync(pendingFile(sessionId), "utf-8")) as PendingPayload; }
  catch { return null; }
}

export function readPendingStatus(sessionId: string): PendingStatus | null {
  try { return JSON.parse(fs.readFileSync(statusFile(sessionId), "utf-8")) as PendingStatus; }
  catch { return null; }
}

export function completePending(sessionId: string, result: { status: "processing" | "done" | "failed"; new_file_path?: string; error?: string }): void {
  ensurePendingDir();
  fs.writeFileSync(statusFile(sessionId), JSON.stringify({ ...result, updated_at: new Date().toISOString() }), "utf-8");
}

/** Return the most recently submitted session ID across all pending files (for apply_viewer_updates without explicit session_id). */
export function findLatestPendingSession(): string | null {
  try {
    ensurePendingDir();
    const files = fs.readdirSync(PENDING_DIR)
      .filter(f => f.endsWith(".json") && !f.endsWith(".status.json"))
      .map(f => ({ f, mtime: fs.statSync(path.join(PENDING_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return files[0].f.replace(/\.json$/, "");
  } catch { return null; }
}

let serverPort: number = PORT;
let started = false;

function ensureDir(): void {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch { /* exists */ }
}

function fileFor(id: string): string {
  return path.join(STORE_DIR, `${id}.html`);
}

function cleanup(): void {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(STORE_DIR)) {
      const p = path.join(STORE_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p);
      } catch { /* race — ignore */ }
    }
  } catch { /* dir missing — ignore */ }
}

export function startViewerServer(): void {
  if (started) return;
  started = true;
  ensureDir();

  function tryListen(port: number): void {
    const srv = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

      // CORS preflight (needed for JSON POSTs from file:// pages)
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      // ── Pending-update endpoints (viewer → MCP) ─────────────────────────────

      // POST /pending/:id — viewer submits edited properties; body is PendingPayload JSON
      const postPending = req.url?.match(/^\/pending\/([a-f0-9]{16})$/);
      if (postPending && req.method === "POST") {
        const id = postPending[1];
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body) as PendingPayload;
            payload.session_id = id;
            payload.submitted_at = new Date().toISOString();
            storePending(payload);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, session_id: id }));
          } catch {
            res.writeHead(400); res.end("Bad JSON");
          }
        });
        return;
      }

      // GET /pending/:id/status — viewer polls for job completion
      const getPendingStatus = req.url?.match(/^\/pending\/([a-f0-9]{16})\/status$/);
      if (getPendingStatus && req.method === "GET") {
        const id = getPendingStatus[1];
        const s = readPendingStatus(id);
        res.writeHead(s ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(s ?? { status: "not_found" }));
        return;
      }

      // POST /pending/:id/complete — MCP tool marks the job done
      const postComplete = req.url?.match(/^\/pending\/([a-f0-9]{16})\/complete$/);
      if (postComplete && req.method === "POST") {
        const id = postComplete[1];
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const result = JSON.parse(body) as { status: "done" | "failed"; new_file_path?: string; error?: string };
            completePending(id, result);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400); res.end("Bad JSON");
          }
        });
        return;
      }

      // Image route: serve a thumbnail PNG (for Markdown-image embedding in chat).
      const imgId = req.url?.match(/^\/img\/([a-f0-9]{16})\.png$/)?.[1];
      if (imgId) {
        const ip = path.join(STORE_DIR, `${imgId}.png`);
        try {
          const buf = fs.readFileSync(ip);
          res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
          res.end(buf);
        } catch {
          res.writeHead(404); res.end("Not found");
        }
        return;
      }

      const id = req.url?.match(/^\/v\/([a-f0-9]{16})$/)?.[1];
      if (!id) { res.writeHead(404); res.end("Not found"); return; }

      const p = fileFor(id);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(p);
      } catch {
        res.writeHead(404);
        res.end("Viewer not found — it may have been cleaned up. Call render_model again to refresh.");
        return;
      }
      if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
        res.writeHead(410);
        res.end("Viewer session expired — call render_model again to refresh.");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(p, "utf-8"));
    });

    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && port < PORT + 10) {
        tryListen(port + 1);
      } else {
        process.stderr.write(`[viewer-server] Failed to bind: ${err.message}\n`);
      }
    });

    srv.listen(port, "127.0.0.1", () => {
      serverPort = port;
      process.stderr.write(`[mcp-workflow-builder] Viewer server on http://127.0.0.1:${port}\n`);
    });

    cleanup();
    setInterval(cleanup, 15 * 60 * 1000).unref();
  }

  tryListen(PORT);
}

export function registerViewer(html: string, _ttlSeconds: number): string {
  ensureDir();
  const id = randomBytes(8).toString("hex"); // 16 hex chars
  fs.writeFileSync(fileFor(id), html, "utf-8");
  return `http://127.0.0.1:${serverPort}/v/${id}`;
}

// Serve a PNG (thumbnail) for Markdown-image embedding in chat. Returns the localhost image URL.
export function registerImage(png: Buffer): string {
  ensureDir();
  const id = randomBytes(8).toString("hex");
  fs.writeFileSync(path.join(STORE_DIR, `${id}.png`), png);
  return `http://127.0.0.1:${serverPort}/img/${id}.png`;
}
