// Workflow runner — the Phase-2 deterministic engine for run_saved_workflow.
//
// Given a saved manifest + per-run inputs, it:
//   1. validates inputs against the manifest's input contract,
//   2. uploads each file-path input ONCE,
//   3. walks steps[] in dependency order, substituting {{placeholders}} and threading
//      `produces` outputs into downstream `input_file_url`,
//   4. executes each step via the EXISTING execute_workflow handler (no reimplementation),
//   5. chains synchronous REST steps inline, and yields a resumable `run_handle` at each
//      async (Design Automation) boundary so the caller polls + re-invokes — keeping every
//      tool call bounded, exactly like get_workflow_status.
//
// Determinism lives in steps 1–3 (order, substitution, threading — no LLM judgment).
// The executor functions are injected so the engine is unit-testable without live APS.

import {
  collectPlaceholders,
  type WorkflowManifest,
  type SkillStep,
} from "./skill-manifest.js";

// ── Injected executor surface (the real handlers, or mocks in tests) ────────

export interface ExecStepResult {
  status: "success" | "pending" | "failed" | "activity_not_found" | "error" | "3lo_required";
  workflow_handle?: unknown;
  outputOssUrls?: string[];
  outputOssUrl?: string;
  response_oss_url?: string;
  reportUrl?: string;
  error?: string;
  hint?: string;
}

export interface PollResult {
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "error";
  outputOssUrls?: string[];
  reportUrl?: string;
  error?: string;
}

export interface UploadResult {
  status: "success" | "bridge_required" | "error";
  oss_url?: string;
  error?: string;
  REQUIRED_ACTION?: string;
  mac_path_hint?: string;
}

export interface ResultPreview {
  oss_url: string;
  detected_as?: string;
  size_bytes?: number;
  preview?: string;
  saved_to?: string;
  binary?: boolean;
}

export interface RunnerDeps {
  uploadFile(filePath: string): Promise<UploadResult>;
  execute(input: {
    capability_id: string;
    operation_id: string;
    args?: Record<string, unknown>;
    config?: Record<string, unknown>;
    input_file_url?: string;
  }): Promise<ExecStepResult>;
  pollStatus(workflowHandle: unknown): Promise<PollResult>;
  getResult(ossUrl: string): Promise<ResultPreview>;
}

// ── Resumable run state (the opaque run_handle handed back to the caller) ───

export interface RunState {
  version: 1;
  slug: string;
  resolvedInputs: Record<string, unknown>;
  fileUrls: Record<string, string>;        // file-input key -> uploaded oss url
  stepOutputs: Record<string, string[]>;    // step id -> output oss urls
  completed: string[];
  pending?: { stepId: string; workflow_handle: unknown };
  startedAt: number;
}

export type RunResult =
  | { status: "success"; slug: string; steps_completed: number; outputs: { stepId: string; oss_urls: string[] }[]; results: ResultPreview[] }
  | { status: "pending"; slug: string; run_handle: RunState; current_step: string; next_action: string }
  | { status: "3lo_required"; slug: string; run_handle: RunState; next_action: string }
  | { status: "failed"; slug: string; step?: string; error: string; reportUrl?: string; hint?: string }
  | { status: "error"; error: string; hint?: string };

// ── Input validation against the manifest contract ──────────────────────────

function validateInputs(
  manifest: WorkflowManifest,
  raw: Record<string, unknown>
): { ok: true; resolved: Record<string, unknown> } | { ok: false; error: string; hint?: string } {
  const resolved: Record<string, unknown> = {};
  for (const def of manifest.inputs) {
    const provided = raw[def.key];
    if (provided === undefined || provided === null || provided === "") {
      if (def.required && def.default === undefined) {
        return { ok: false, error: `Missing required input '${def.key}'.`, hint: def.prompt };
      }
      if (def.default !== undefined) resolved[def.key] = def.default;
      continue;
    }
    if (def.type === "enum" && def.values && !def.values.includes(String(provided))) {
      return {
        ok: false,
        error: `Input '${def.key}'='${String(provided)}' is not one of [${def.values.join(", ")}].`,
      };
    }
    resolved[def.key] = provided;
  }
  return { ok: true, resolved };
}

// ── Placeholder substitution ────────────────────────────────────────────────

function substitute<T>(value: T, ctx: Record<string, unknown>): T {
  if (typeof value === "string") {
    // Whole-string single placeholder → preserve the value's native type.
    const whole = value.match(/^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/);
    if (whole && whole[1] in ctx) return ctx[whole[1]] as unknown as T;
    return value.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, k) =>
      k in ctx ? String(ctx[k]) : m
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, ctx);
    return out as unknown as T;
  }
  return value;
}

// ── DAG helpers ──────────────────────────────────────────────────────────────

function findReadyStep(manifest: WorkflowManifest, state: RunState): SkillStep | undefined {
  const done = new Set(state.completed);
  const busy = state.pending?.stepId;
  return manifest.steps.find(
    (s) => !done.has(s.id) && s.id !== busy && s.depends_on.every((d) => done.has(d))
  );
}

/** Steps whose `produces` is consumed by some other step's input_file_url. */
function consumedProduces(manifest: WorkflowManifest): Set<string> {
  const consumed = new Set<string>();
  const producesNames = new Set(manifest.steps.map((s) => s.produces).filter(Boolean) as string[]);
  for (const s of manifest.steps) {
    if (s.input_file_url && producesNames.has(s.input_file_url.trim())) consumed.add(s.input_file_url.trim());
  }
  return consumed;
}

/** Static validation of the step graph (called once at run start). */
function validateGraph(manifest: WorkflowManifest): string | null {
  const ids = new Set(manifest.steps.map((s) => s.id));
  if (ids.size !== manifest.steps.length) return "Duplicate step ids in manifest.";
  for (const s of manifest.steps) {
    for (const d of s.depends_on) {
      if (!ids.has(d)) return `Step '${s.id}' depends_on unknown step '${d}'.`;
    }
  }
  return null;
}

/** Resolve a step's input_file_url: prior-step output, {{input}} substitution, or literal. */
function resolveInputFileUrl(
  step: SkillStep,
  manifest: WorkflowManifest,
  state: RunState,
  ctx: Record<string, unknown>
): string | undefined {
  if (!step.input_file_url) return undefined;
  const raw = step.input_file_url.trim();
  // Reference to a prior step's named output?
  const producer = manifest.steps.find((s) => s.produces && s.produces === raw);
  if (producer) {
    const outs = state.stepOutputs[producer.id];
    return outs && outs.length ? outs[0] : undefined;
  }
  return substitute(step.input_file_url, ctx);
}

// ── Main engine ──────────────────────────────────────────────────────────────

export async function runWorkflow(
  manifest: WorkflowManifest,
  rawInputs: Record<string, unknown>,
  runHandle: RunState | undefined,
  deps: RunnerDeps
): Promise<RunResult> {
  const graphError = validateGraph(manifest);
  if (graphError) return { status: "error", error: graphError };

  // ── Initialise or resume state ───────────────────────────────────────────
  let state: RunState;
  if (runHandle) {
    state = runHandle;
  } else {
    const v = validateInputs(manifest, rawInputs);
    if (!v.ok) return { status: "error", error: v.error, hint: v.hint };

    // Verify every referenced placeholder is satisfiable from the resolved inputs.
    const referenced = new Set<string>();
    for (const s of manifest.steps) {
      collectPlaceholders(s.input_file_url, referenced);
      collectPlaceholders(s.args, referenced);
      collectPlaceholders(s.config, referenced);
    }
    const missing = [...referenced].filter((k) => !(k in v.resolved));
    if (missing.length) {
      return { status: "error", error: `Inputs missing for placeholder(s): ${missing.join(", ")}.` };
    }

    // Upload each file-path input once.
    const fileUrls: Record<string, string> = {};
    for (const def of manifest.inputs) {
      if (def.type !== "file_path") continue;
      const p = v.resolved[def.key];
      if (typeof p !== "string" || !p) continue;
      const up = await deps.uploadFile(p);
      if (up.status === "bridge_required") {
        return {
          status: "error",
          error: up.REQUIRED_ACTION ?? `Cannot read file for input '${def.key}'.`,
          hint: up.mac_path_hint ?? "Provide the file's real Mac path (~/Downloads/, a local folder, or OneDrive).",
        };
      }
      if (up.status !== "success" || !up.oss_url) {
        return { status: "error", error: `Upload failed for input '${def.key}': ${up.error ?? "unknown error"}` };
      }
      fileUrls[def.key] = up.oss_url;
    }

    state = {
      version: 1,
      slug: manifest.slug,
      resolvedInputs: v.resolved,
      fileUrls,
      stepOutputs: {},
      completed: [],
      startedAt: Date.now(),
    };
  }

  // Substitution context: inputs, with file inputs replaced by their uploaded oss url.
  const ctx: Record<string, unknown> = { ...state.resolvedInputs, ...state.fileUrls };

  // ── Resume: poll a pending async step ──────────────────────────────────────
  if (state.pending) {
    const poll = await deps.pollStatus(state.pending.workflow_handle);
    if (poll.status === "pending" || poll.status === "running") {
      return {
        status: "pending",
        slug: manifest.slug,
        run_handle: state,
        current_step: state.pending.stepId,
        next_action: `Step '${state.pending.stepId}' still running. Call run_saved_workflow again with this run_handle (do not modify it).`,
      };
    }
    if (poll.status !== "success") {
      return {
        status: "failed",
        slug: manifest.slug,
        step: state.pending.stepId,
        error: poll.error ?? `Step '${state.pending.stepId}' ${poll.status}.`,
        reportUrl: poll.reportUrl,
      };
    }
    state.stepOutputs[state.pending.stepId] = poll.outputOssUrls ?? [];
    state.completed.push(state.pending.stepId);
    state.pending = undefined;
  }

  // ── Drive ready steps; chain REST inline, yield at DA boundaries ───────────
  const maxIterations = manifest.steps.length + 1;
  for (let i = 0; i < maxIterations; i++) {
    const step = findReadyStep(manifest, state);
    if (!step) break;

    const input_file_url = resolveInputFileUrl(step, manifest, state, ctx);
    if (step.input_file_url && input_file_url === undefined) {
      return { status: "error", error: `Step '${step.id}': could not resolve input_file_url '${step.input_file_url}'.` };
    }
    const args = step.args ? substitute(step.args, ctx) : undefined;
    const config = step.config ? substitute(step.config, ctx) : undefined;

    const res = await deps.execute({
      capability_id: step.capability_id,
      operation_id: step.operation_id,
      args,
      config,
      input_file_url,
    });

    if (res.status === "pending") {
      state.pending = { stepId: step.id, workflow_handle: res.workflow_handle };
      return {
        status: "pending",
        slug: manifest.slug,
        run_handle: state,
        current_step: step.id,
        next_action: `Step '${step.id}' submitted (async). Call run_saved_workflow again with this run_handle to advance.`,
      };
    }
    if (res.status === "3lo_required") {
      state.pending = undefined;
      return {
        status: "3lo_required",
        slug: manifest.slug,
        run_handle: state,
        next_action: `Step '${step.id}' needs a user-identity token. Call authenticate_aps_3lo, then run_saved_workflow again with this run_handle.`,
      };
    }
    if (res.status !== "success") {
      return {
        status: "failed",
        slug: manifest.slug,
        step: step.id,
        error: res.error ?? `Step '${step.id}' ${res.status}.`,
        reportUrl: res.reportUrl,
        hint: res.hint,
      };
    }

    // REST/synchronous success — record outputs and continue the loop inline.
    const outs = res.outputOssUrls ?? (res.outputOssUrl ? [res.outputOssUrl] : res.response_oss_url ? [res.response_oss_url] : []);
    state.stepOutputs[step.id] = outs;
    state.completed.push(step.id);
  }

  // ── Done? ──────────────────────────────────────────────────────────────────
  if (state.completed.length < manifest.steps.length) {
    return {
      status: "error",
      error: "Workflow stalled — no runnable step and not all steps complete. Check depends_on for cycles or unsatisfiable dependencies.",
    };
  }

  // Collect outputs; fetch a preview for terminal-step outputs only.
  const consumed = consumedProduces(manifest);
  const outputs = manifest.steps.map((s) => ({ stepId: s.id, oss_urls: state.stepOutputs[s.id] ?? [] }));
  const terminalUrls: string[] = [];
  for (const s of manifest.steps) {
    const isTerminal = !s.produces || !consumed.has(s.produces);
    if (isTerminal) terminalUrls.push(...(state.stepOutputs[s.id] ?? []));
  }
  const results: ResultPreview[] = [];
  for (const url of terminalUrls) results.push(await deps.getResult(url));

  return {
    status: "success",
    slug: manifest.slug,
    steps_completed: state.completed.length,
    outputs,
    results,
  };
}
