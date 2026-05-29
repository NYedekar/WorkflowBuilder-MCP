// Session store — persists upload cache and active jobs across server restarts.
// Location: ~/Library/Application Support/mcp-workflow-builder/session.json
// TTL: 24h — matches APS transient bucket lifetime.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SESSION_DIR = path.join(os.homedir(), "Library", "Application Support", "mcp-workflow-builder");
const SESSION_FILE = path.join(SESSION_DIR, "session.json");

interface UploadEntry {
  ossUrl: string;
  cachedAt: number;
}

export interface ActiveJob {
  workItemId: string;
  outputOssUrls: string[];
  submittedAt: number;
  capability_id?: string;
  operation_id?: string;
}

interface SessionData {
  version: 1;
  updatedAt: string;
  uploads: Record<string, UploadEntry>;
  jobs: Record<string, ActiveJob>;
}

const UPLOAD_TTL_MS = 20 * 60 * 60 * 1000; // 20h — 4h safety margin before APS 24h transient bucket expiry
const JOB_TTL_MS   = 24 * 60 * 60 * 1000;

let _session: SessionData | null = null;

function load(): SessionData {
  if (_session) return _session;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as SessionData;
    if (parsed.version === 1) {
      _session = parsed;
      prune();
      return _session;
    }
  } catch {
    // missing or corrupt — start fresh
  }
  _session = { version: 1, updatedAt: new Date().toISOString(), uploads: {}, jobs: {} };
  return _session;
}

function save(): void {
  if (!_session) return;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    _session.updatedAt = new Date().toISOString();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(_session, null, 2), "utf-8");
  } catch {
    // non-fatal — in-memory state still valid for this process lifetime
  }
}

function prune(): void {
  if (!_session) return;
  const now = Date.now();
  let pruned = false;
  for (const [k, e] of Object.entries(_session.uploads)) {
    if (now - e.cachedAt > UPLOAD_TTL_MS) { delete _session.uploads[k]; pruned = true; }
  }
  for (const [id, j] of Object.entries(_session.jobs)) {
    if (now - j.submittedAt > JOB_TTL_MS) { delete _session.jobs[id]; pruned = true; }
  }
  if (pruned) save();
}

// ── Upload cache ──────────────────────────────────────────────────────────

export function getPersistedUpload(cacheKey: string): string | null {
  const s = load();
  const entry = s.uploads[cacheKey];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > UPLOAD_TTL_MS) {
    delete s.uploads[cacheKey];
    save();
    return null;
  }
  return entry.ossUrl;
}

export function setPersistedUpload(cacheKey: string, ossUrl: string): void {
  const s = load();
  s.uploads[cacheKey] = { ossUrl, cachedAt: Date.now() };
  save();
}

// ── Active jobs ───────────────────────────────────────────────────────────

export function saveActiveJob(job: ActiveJob): void {
  const s = load();
  s.jobs[job.workItemId] = job;
  save();
}

export function removeActiveJob(workItemId: string): void {
  const s = load();
  if (s.jobs[workItemId]) {
    delete s.jobs[workItemId];
    save();
  }
}

// Returns a recovery hint for jobs submitted in a previous server instance, or null if none.
export function getSessionRecoverySummary(): string | null {
  const s = load();
  const jobs = Object.values(s.jobs);
  if (jobs.length === 0) return null;
  const list = jobs
    .map((j) => {
      const handle = JSON.stringify({
        type: "da_workitem",
        workItemId: j.workItemId,
        outputOssUrls: j.outputOssUrls,
      });
      return (
        `  • ${j.capability_id ?? "unknown"} · submitted ${new Date(j.submittedAt).toLocaleTimeString()}\n` +
        `    Resume: get_workflow_status(workflow_handle=${handle})`
      );
    })
    .join("\n");
  return (
    `RECOVERED SESSION — ${jobs.length} job(s) from a previous server instance may still be running:\n${list}\n` +
    `Call get_workflow_status with the handle above to check status and retrieve outputs.`
  );
}
