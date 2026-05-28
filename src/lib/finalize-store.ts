import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { S3FinalizeEntry } from "../tools/execute-workflow.js";

// Persist s3FinalizeQueue to disk keyed by workItemId so it survives
// connection drops between execute_workflow and get_workflow_status.
// The LLM may reconstruct workflow_handle from memory, dropping the queue —
// this store is the authoritative source.

const STORE_DIR = path.join(os.tmpdir(), "wf-finalize");

export function persistFinalizeQueue(workItemId: string, queue: S3FinalizeEntry[]): void {
  if (queue.length === 0) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STORE_DIR, `${workItemId}.json`),
      JSON.stringify(queue),
      "utf-8"
    );
  } catch {
    // Non-fatal — in-handle queue is the fallback
  }
}

export function loadFinalizeQueue(workItemId: string): S3FinalizeEntry[] {
  try {
    const raw = fs.readFileSync(path.join(STORE_DIR, `${workItemId}.json`), "utf-8");
    return JSON.parse(raw) as S3FinalizeEntry[];
  } catch {
    return [];
  }
}

export function cleanFinalizeQueue(workItemId: string): void {
  try {
    fs.unlinkSync(path.join(STORE_DIR, `${workItemId}.json`));
  } catch {
    // Already gone
  }
}
