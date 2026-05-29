#!/usr/bin/env tsx
// Registry validation — runs before tsc at build time.
// Fails with exit code 1 if any check fails so the build stops immediately.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const registryPath =
  process.env.APS_REGISTRY_PATH ??
  resolve(__dir, "../data/capability-registry.json");

let raw: Record<string, unknown>;
try {
  raw = JSON.parse(readFileSync(registryPath, "utf-8")) as Record<string, unknown>;
} catch (err) {
  console.error(`[validate-registry] Cannot load registry: ${String(err)}`);
  process.exit(1);
}

// ── Collect all operations ─────────────────────────────────────────────────

interface Op {
  capId: string;
  opId: string;
  callable?: boolean;
  asyncJob?: boolean;
  asyncJobPolling?: unknown;
  endpoint?: string;
  baseUrl?: string;
  httpMethod?: string;
}

const ops: Op[] = [];

function collectOps(cap: Record<string, unknown>): void {
  const capId = cap.id as string ?? "(unknown)";
  const capBaseUrl = cap.baseUrl as string | undefined;
  for (const op of (cap.operations as unknown[]) ?? []) {
    const o = op as Record<string, unknown>;
    ops.push({
      capId,
      opId: o.operationId as string ?? "(unknown)",
      callable: o.callable as boolean | undefined,
      asyncJob: o.asyncJob as boolean | undefined,
      asyncJobPolling: o.asyncJobPolling,
      endpoint: o.endpoint as string | undefined,
      baseUrl: (o.baseUrl ?? capBaseUrl) as string | undefined,
      httpMethod: o.httpMethod as string | undefined,
    });
  }
}

for (const domain of (raw.domains as unknown[]) ?? []) {
  const d = domain as Record<string, unknown>;
  for (const engine of (d.engines as unknown[]) ?? []) {
    const eng = engine as Record<string, unknown>;
    for (const cg of (eng.capabilityGroups as unknown[]) ?? []) {
      const g = cg as Record<string, unknown>;
      for (const cap of (g.capabilities as unknown[]) ?? []) {
        collectOps(cap as Record<string, unknown>);
      }
    }
  }
  for (const api of (d.apis as unknown[]) ?? []) {
    const a = api as Record<string, unknown>;
    for (const cg of (a.capabilityGroups as unknown[]) ?? []) {
      const g = cg as Record<string, unknown>;
      for (const cap of (g.capabilities as unknown[]) ?? []) {
        collectOps(cap as Record<string, unknown>);
      }
    }
  }
}

// ── Checks ─────────────────────────────────────────────────────────────────

const errors: string[] = [];   // hard failures — block the build
const warnings: string[] = []; // soft issues — logged but don't block

// 1. HARD FAIL: {PLACEHOLDER} template vars (uppercase) in endpoint/baseUrl of callable ops.
//    Lowercase {bucketKey} style path params are intentional; only uppercase-only vars
//    are unresolved registry templates that slip past build time.
for (const op of ops) {
  if (op.callable === false) continue;
  const combined = [op.endpoint, op.baseUrl].filter(Boolean).join(" ");
  const placeholders = [...combined.matchAll(/\{[A-Z][A-Z0-9_]+\}/g)].map((m) => m[0]);
  if (placeholders.length > 0) {
    errors.push(
      `PLACEHOLDER: ${op.capId}/${op.opId} has unfilled template vars in endpoint/baseUrl: ${placeholders.join(", ")}`
    );
  }
}

// 2. HARD FAIL: baseUrl + endpoint must not produce double-slash URLs.
for (const op of ops) {
  if (!op.baseUrl || !op.endpoint) continue;
  const joined = op.baseUrl.replace(/\/$/, "") + op.endpoint;
  if (joined.replace(/^https?:\/\//, "").includes("//")) {
    errors.push(
      `DOUBLE_SLASH: ${op.capId}/${op.opId} — baseUrl="${op.baseUrl}" + endpoint="${op.endpoint}" produces double-slash`
    );
  }
}

// 3. WARN: asyncJob:true ops without asyncJobPolling degrade LLM guidance (not a hard failure —
//    these are registry gaps for known-incomplete capabilities).
for (const op of ops) {
  if (op.asyncJob !== true) continue;
  if (!op.asyncJobPolling) {
    warnings.push(
      `MISSING_POLLING: ${op.capId}/${op.opId} has asyncJob=true but asyncJobPolling is not set — LLM will get generic polling note`
    );
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

const callableCount = ops.filter((o) => o.callable !== false).length;
console.log(`[validate-registry] Checked ${ops.length} ops (${callableCount} callable) across registry.`);

if (warnings.length > 0) {
  console.warn(`\n[validate-registry] ${warnings.length} warning(s) (non-blocking):`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  console.warn("");
}

if (errors.length > 0) {
  console.error(`[validate-registry] FAILED — ${errors.length} hard error(s):\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error("");
  process.exit(1);
}

console.log(`[validate-registry] OK — all hard checks passed${warnings.length > 0 ? ` (${warnings.length} warning(s) above)` : ""}.`);
