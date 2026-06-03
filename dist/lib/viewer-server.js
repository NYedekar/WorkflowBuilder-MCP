import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
const PORT = 7830;
// Disk-backed store: the MCP process is restarted often by Claude Desktop, which wiped the old
// in-memory Map and 404'd every previously-issued viewer link. Persisting to a temp dir makes
// links survive restarts — and any server instance (on any port) can serve any id from the same dir.
const STORE_DIR = path.join(os.tmpdir(), "aps-mcp-viewers");
const MAX_AGE_MS = 60 * 60 * 1000; // viewer token lives ~1h; serve the file within that window
let serverPort = PORT;
let started = false;
function ensureDir() {
    try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
    }
    catch { /* exists */ }
}
function fileFor(id) {
    return path.join(STORE_DIR, `${id}.html`);
}
function cleanup() {
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(STORE_DIR)) {
            const p = path.join(STORE_DIR, f);
            try {
                if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS)
                    fs.unlinkSync(p);
            }
            catch { /* race — ignore */ }
        }
    }
    catch { /* dir missing — ignore */ }
}
export function startViewerServer() {
    if (started)
        return;
    started = true;
    ensureDir();
    function tryListen(port) {
        const srv = http.createServer((req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Content-Security-Policy", "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
            const id = req.url?.match(/^\/v\/([a-f0-9]{16})$/)?.[1];
            if (!id) {
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            const p = fileFor(id);
            let stat;
            try {
                stat = fs.statSync(p);
            }
            catch {
                res.writeHead(404);
                res.end("Viewer not found — it may have been cleaned up. Call render_model again to refresh.");
                return;
            }
            if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
                try {
                    fs.unlinkSync(p);
                }
                catch { /* ignore */ }
                res.writeHead(410);
                res.end("Viewer session expired — call render_model again to refresh.");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(fs.readFileSync(p, "utf-8"));
        });
        srv.on("error", (err) => {
            if (err.code === "EADDRINUSE" && port < PORT + 10) {
                tryListen(port + 1);
            }
            else {
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
export function registerViewer(html, _ttlSeconds) {
    ensureDir();
    const id = randomBytes(8).toString("hex"); // 16 hex chars
    fs.writeFileSync(fileFor(id), html, "utf-8");
    return `http://127.0.0.1:${serverPort}/v/${id}`;
}
