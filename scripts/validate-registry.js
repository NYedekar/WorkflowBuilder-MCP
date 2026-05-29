#!/usr/bin/env node
// Registry validation — runs at build time via: node scripts/validate-registry.js
// No TypeScript compilation or tsx required. Uses only Node.js built-ins.
// Exits non-zero on hard errors so the build stops immediately.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const registryPath =
  process.env.APS_REGISTRY_PATH ??
  resolve(__dir, "../data/capability-registry.json");

let raw;
try {
  raw = JSON.parse(readFileSync(registryPath, "utf-8"));
} catch (err) {
  console.error(`[validate-registry] Cannot load registry: ${String(err)}`);
  process.exit(1);
}

// ── Collect all operations ─────────────────────────────────────────────────

const ops = [];

function collectOps(cap) {
  const capId = cap.id ?? "(unknown)";
  const capBaseUrl = cap.baseUrl;
  for (const op of cap.operations ?? []) {
    ops.push({
      capId,
      opId: op.operationId ?? "(unknown)",
      callable: op.callable,
      asyncJob: op.asyncJob,
      asyncJobPolling: op.asyncJobPolling,
      endpoint: op.endpoint,
      baseUrl: op.baseUrl ?? capBaseUrl,
    });
  }
}

for (const domain of raw.domains ?? []) {
  for (const engine of domain.engines ?? []) {
    for (const cg of engine.capabilityGroups ?? []) {
      for (const cap of cg.capabilities ?? []) collectOps(cap);
    }
  }
  for (const api of domain.apis ?? []) {
    for (const cg of api.capabilityGroups ?? []) {
      for (const cap of cg.capabilities ?? []) collectOps(cap);
    }
  }
}

// ── Checks ─────────────────────────────────────────────────────────────────

const errors = [];   // hard failures — block the build
const warnings = []; // soft issues — logged but don't block

// 1. HARD FAIL: uppercase-only {PLACEHOLDER} vars in endpoint/baseUrl of callable ops.
//    Lowercase {bucketKey} style path params are intentional APS REST conventions.
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

// 2. HARD FAIL: double-slash in baseUrl + endpoint combination.
for (const op of ops) {
  if (!op.baseUrl || !op.endpoint) continue;
  const joined = op.baseUrl.replace(/\/$/, "") + op.endpoint;
  if (joined.replace(/^https?:\/\//, "").includes("//")) {
    errors.push(
      `DOUBLE_SLASH: ${op.capId}/${op.opId} — baseUrl="${op.baseUrl}" + endpoint="${op.endpoint}" produces double-slash`
    );
  }
}

// 3. WARN: asyncJob:true without asyncJobPolling — LLM gets generic polling note.
for (const op of ops) {
  if (op.asyncJob !== true) continue;
  if (!op.asyncJobPolling) {
    warnings.push(
      `MISSING_POLLING: ${op.capId}/${op.opId} has asyncJob=true but asyncJobPolling is not set`
    );
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

const callableCount = ops.filter((o) => o.callable !== false).length;
console.log(`[validate-registry] Checked ${ops.length} ops (${callableCount} callable).`);

if (warnings.length > 0) {
  console.warn(`[validate-registry] ${warnings.length} warning(s) (non-blocking):`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
}

if (errors.length > 0) {
  console.error(`\n[validate-registry] FAILED — ${errors.length} hard error(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

console.log(`[validate-registry] OK — all hard checks passed.`);
