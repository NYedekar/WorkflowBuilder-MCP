import http from "http";
import { createWriteStream, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PREFERRED_PORT = 3556;
let _port: number | null = null;

export function getBridgePort(): number | null {
  return _port;
}

export function getBridgeTempDir(): string {
  return join(tmpdir(), "mcp-bridge");
}

export function startHttpBridge(): Promise<number> {
  return new Promise((resolve) => {
    const tempDir = getBridgeTempDir();
    try {
      mkdirSync(tempDir, { recursive: true });
    } catch {}

    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/bridge/upload")) {
        res.writeHead(404);
        res.end();
        return;
      }

      let filename = "upload";
      try {
        const qmark = req.url.indexOf("?");
        if (qmark !== -1) {
          const params = new URLSearchParams(req.url.slice(qmark + 1));
          filename = params.get("filename") ?? "upload";
        }
        // Strip directory components and dangerous chars
        filename = filename
          .replace(/[/\\<>:"|?*\x00-\x1f]/g, "_")
          .slice(0, 255) || "upload";
      } catch {}

      const tempPath = join(tempDir, filename);
      const ws = createWriteStream(tempPath);

      req.pipe(ws);

      ws.on("finish", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", temp_path: tempPath }));
      });

      ws.on("error", (err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });

      req.on("error", () => ws.destroy());
    });

    const tryPort = (port: number) => {
      server.removeAllListeners("error");
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < PREFERRED_PORT + 5) {
          tryPort(port + 1);
        } else {
          // Bridge unavailable — server still works, fallback to REQUIRED_ACTION
          console.error(`HTTP bridge could not start: ${err.message}`);
          resolve(-1);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        _port = port;
        console.error(`mcp-workflow-builder HTTP bridge on localhost:${port}`);
        resolve(port);
      });
    };

    tryPort(PREFERRED_PORT);
  });
}
