import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TokenUsageRecord } from "./record-token-usage.js";

// ── Storage ──────────────────────────────────────────────────────────────

function getLogPath(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "mcp-workflow-builder",
    "token-usage.jsonl"
  );
}

function readAllRecords(): TokenUsageRecord[] {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  const records: TokenUsageRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as TokenUsageRecord);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

// ── Schema ────────────────────────────────────────────────────────────────

export const getTokenUsageSchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "ISO 8601 date or datetime to filter from (inclusive). " +
        "Examples: '2026-05-29', '2026-05-29T14:00:00Z'. " +
        "Omit to include all historical records."
    ),
  until: z
    .string()
    .optional()
    .describe(
      "ISO 8601 date or datetime to filter to (inclusive). " +
        "Omit to include up to and including now."
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      "Filter to a specific MCP session ID. " +
        "The current session ID is returned in each record_token_usage response."
    ),
  workflow_id: z
    .string()
    .optional()
    .describe("Filter to usage records associated with a specific workflow DAG ID."),
  model: z
    .string()
    .optional()
    .describe("Filter to a specific model ID (e.g. 'claude-sonnet-4-6')."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .default(100)
    .describe("Maximum number of raw records to include in recent_records (default 100, max 500)."),
});

export type GetTokenUsageInput = z.infer<typeof getTokenUsageSchema>;

interface ModelBreakdown {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  record_count: number;
}

interface WorkflowBreakdown {
  workflow_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  record_count: number;
}

export interface GetTokenUsageOutput {
  filters_applied: Record<string, string>;
  summary: {
    record_count: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    earliest_record?: string;
    latest_record?: string;
  };
  by_model: ModelBreakdown[];
  by_workflow: WorkflowBreakdown[];
  recent_records: TokenUsageRecord[];
  log_path: string;
}

export async function handleGetTokenUsage(
  input: GetTokenUsageInput
): Promise<GetTokenUsageOutput> {
  let records = readAllRecords();

  const filtersApplied: Record<string, string> = {};

  if (input.since) {
    const sinceTs = new Date(input.since).getTime();
    records = records.filter((r) => new Date(r.timestamp).getTime() >= sinceTs);
    filtersApplied["since"] = input.since;
  }
  if (input.until) {
    const untilTs = new Date(input.until).getTime();
    records = records.filter((r) => new Date(r.timestamp).getTime() <= untilTs);
    filtersApplied["until"] = input.until;
  }
  if (input.session_id) {
    records = records.filter((r) => r.session_id === input.session_id);
    filtersApplied["session_id"] = input.session_id;
  }
  if (input.workflow_id) {
    records = records.filter((r) => r.workflow_id === input.workflow_id);
    filtersApplied["workflow_id"] = input.workflow_id;
  }
  if (input.model) {
    records = records.filter((r) => r.model === input.model);
    filtersApplied["model"] = input.model;
  }

  // ── Aggregations ──────────────────────────────────────────────────────

  const summary = {
    record_count: records.length,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    earliest_record: records[0]?.timestamp,
    latest_record: records[records.length - 1]?.timestamp,
  };

  const modelMap = new Map<string, ModelBreakdown>();
  const workflowMap = new Map<string, WorkflowBreakdown>();

  for (const r of records) {
    summary.input_tokens += r.input_tokens;
    summary.output_tokens += r.output_tokens;
    summary.total_tokens += r.input_tokens + r.output_tokens;
    summary.cache_read_tokens += r.cache_read_tokens ?? 0;
    summary.cache_write_tokens += r.cache_write_tokens ?? 0;

    // by_model
    if (!modelMap.has(r.model)) {
      modelMap.set(r.model, {
        model: r.model,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        record_count: 0,
      });
    }
    const mb = modelMap.get(r.model)!;
    mb.input_tokens += r.input_tokens;
    mb.output_tokens += r.output_tokens;
    mb.total_tokens += r.input_tokens + r.output_tokens;
    mb.cache_read_tokens += r.cache_read_tokens ?? 0;
    mb.cache_write_tokens += r.cache_write_tokens ?? 0;
    mb.record_count += 1;

    // by_workflow
    if (r.workflow_id) {
      if (!workflowMap.has(r.workflow_id)) {
        workflowMap.set(r.workflow_id, {
          workflow_id: r.workflow_id,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          record_count: 0,
        });
      }
      const wb = workflowMap.get(r.workflow_id)!;
      wb.input_tokens += r.input_tokens;
      wb.output_tokens += r.output_tokens;
      wb.total_tokens += r.input_tokens + r.output_tokens;
      wb.record_count += 1;
    }
  }

  const limit = input.limit ?? 100;

  return {
    filters_applied: filtersApplied,
    summary,
    by_model: [...modelMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    by_workflow: [...workflowMap.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    recent_records: records.slice(-limit),
    log_path: getLogPath(),
  };
}
