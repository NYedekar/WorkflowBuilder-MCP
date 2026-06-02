import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Storage ──────────────────────────────────────────────────────────────

function getLogPath(): string {
  const dir = path.join(os.homedir(), "Library", "Application Support", "mcp-workflow-builder");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "token-usage.jsonl");
}

// ── Schema ────────────────────────────────────────────────────────────────

export const recordTokenUsageSchema = z.object({
  model: z
    .string()
    .describe(
      "The model ID that generated these tokens (e.g. 'claude-sonnet-4-6', 'claude-opus-4-8'). " +
        "Use the exact model ID string from your API response metadata."
    ),
  input_tokens: z
    .number()
    .int()
    .nonnegative()
    .describe("Prompt / input tokens consumed in this call or batch of calls."),
  output_tokens: z
    .number()
    .int()
    .nonnegative()
    .describe("Completion / output tokens generated in this call or batch of calls."),
  cache_read_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Cache-read tokens (prompt-cache hits). Omit if not applicable."),
  cache_write_tokens: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Cache-write tokens (prompt-cache population). Omit if not applicable."),
  workflow_id: z
    .string()
    .optional()
    .describe(
      "Workflow DAG ID if this usage was incurred while building or executing a create_workflow DAG. " +
        "Match the 'id' field returned by create_workflow."
    ),
  capability_id: z
    .string()
    .optional()
    .describe(
      "Capability ID that was executed (e.g. 'RevitElementDataExtraction'). " +
        "Use when recording usage from a single execute_workflow or process_file call."
    ),
  operation_id: z
    .string()
    .optional()
    .describe("Operation ID within the capability (e.g. 'extract-room-data')."),
  session_id: z
    .string()
    .optional()
    .describe(
      "Optional session identifier to group multiple calls in the same conversation. " +
        "If omitted, the MCP server's startup session ID is used automatically."
    ),
  notes: z
    .string()
    .optional()
    .describe("Free-text annotation (e.g. 'post-processing loop', 'initial planning step')."),
});

export type RecordTokenUsageInput = z.infer<typeof recordTokenUsageSchema>;

export interface TokenUsageRecord {
  timestamp: string;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  workflow_id?: string;
  capability_id?: string;
  operation_id?: string;
  notes?: string;
}

export interface RecordTokenUsageOutput {
  status: "recorded";
  record_id: string;
  log_path: string;
  running_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  summary_line: string; // Output this verbatim as the last line of your response after every workflow.
  _save_skill_offer: string; // Proactive save-as-skill nudge — record_token_usage is the mandated final step.
}

// record_token_usage is the documented LAST step of every complete workflow, so it's the most
// reliable place to surface the proactive offer (other terminal tools vary: get_result vs
// get_download_link vs here). Best-effort + text-based; the guaranteed path is the user saying
// "save this as a skill".
const SAVE_SKILL_OFFER =
  "BEFORE the final summary_line: if this workflow is something the user might run again, and it was " +
  "NOT launched from a saved workflow (run_saved_workflow), proactively ASK the user " +
  '"Want me to save this as a reusable skill you can re-run on any file?" If they say yes, call ' +
  "save_workflow_as_skill with the exact steps you just ran. Then output summary_line as the very last line. " +
  "Skip only trivial one-offs.";

// Per-process session ID (stable for the lifetime of one MCP server instance).
export const SERVER_SESSION_ID: string = (() => {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `sess_${ts}_${rand}`;
})();

// In-memory running totals for the current session (fast path for the AI).
let sessionInputTotal = 0;
let sessionOutputTotal = 0;

export async function handleRecordTokenUsage(
  input: RecordTokenUsageInput
): Promise<RecordTokenUsageOutput> {
  const record: TokenUsageRecord = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id ?? SERVER_SESSION_ID,
    model: input.model,
    input_tokens: input.input_tokens,
    output_tokens: input.output_tokens,
    ...(input.cache_read_tokens !== undefined && { cache_read_tokens: input.cache_read_tokens }),
    ...(input.cache_write_tokens !== undefined && { cache_write_tokens: input.cache_write_tokens }),
    ...(input.workflow_id && { workflow_id: input.workflow_id }),
    ...(input.capability_id && { capability_id: input.capability_id }),
    ...(input.operation_id && { operation_id: input.operation_id }),
    ...(input.notes && { notes: input.notes }),
  };

  // Unique record ID: session + monotonic counter approximated via timestamp+rand.
  const record_id = `${record.session_id}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  const logPath = getLogPath();
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");

  sessionInputTotal += input.input_tokens;
  sessionOutputTotal += input.output_tokens;

  const total = sessionInputTotal + sessionOutputTotal;
  const summaryLine =
    `Session token usage: ${total.toLocaleString()} tokens ` +
    `(${sessionInputTotal.toLocaleString()} input · ${sessionOutputTotal.toLocaleString()} output) — ${input.model}`;

  return {
    status: "recorded",
    record_id,
    log_path: logPath,
    running_totals: {
      input_tokens: sessionInputTotal,
      output_tokens: sessionOutputTotal,
      total_tokens: total,
    },
    summary_line: summaryLine,
    _save_skill_offer: SAVE_SKILL_OFFER,
  };
}
