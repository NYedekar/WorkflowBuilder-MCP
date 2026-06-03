import * as http from "http";
import { randomBytes } from "crypto";

const PORT = 7830;

type ViewerEntry = { html: string; expiresAt: number };
const store = new Map<string, ViewerEntry>();

let serverPort: number = PORT;
let started = false;

export function startViewerServer(): void {
  if (started) return;
  started = true;

  function tryListen(port: number): void {
    const srv = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");

      const id = req.url?.match(/^\/v\/([a-f0-9]{16})$/)?.[1];
      if (!id) { res.writeHead(404); res.end("Not found"); return; }

      const entry = store.get(id);
      if (!entry) { res.writeHead(404); res.end("Not found"); return; }
      if (Date.now() > entry.expiresAt) {
        store.delete(id);
        res.writeHead(410);
        res.end("Viewer token expired — call render_model again to refresh.");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(entry.html);
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

    // Expire old entries every 15 minutes; .unref() so timer doesn't block process exit
    setInterval(() => {
      const now = Date.now();
      for (const [id, e] of store) if (now > e.expiresAt) store.delete(id);
    }, 15 * 60 * 1000).unref();
  }

  tryListen(PORT);
}

export function registerViewer(html: string, ttlSeconds: number): string {
  const id = randomBytes(8).toString("hex"); // 16 hex chars
  store.set(id, { html, expiresAt: Date.now() + ttlSeconds * 1000 });
  return `http://127.0.0.1:${serverPort}/v/${id}`;
}
