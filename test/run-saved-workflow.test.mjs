// Unit tests for the Phase-2 deterministic engine (workflow-runner) + manifest-store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { runWorkflow } from "../dist/lib/workflow-runner.js";
import { loadManifest, listManifests } from "../dist/lib/manifest-store.js";
import { workflowManifestSchema } from "../dist/lib/skill-manifest.js";

function manifest(overrides) {
  return workflowManifestSchema.parse({
    schema_version: 1,
    name: "Test WF",
    slug: "test-wf",
    intent: "x",
    description: "d",
    auth_mode: "2LO",
    inputs: [],
    steps: [],
    created_at: "2026-06-01T00:00:00.000Z",
    generator: "test",
    ...overrides,
  });
}

// A configurable mock executor surface.
function mockDeps(opts = {}) {
  const calls = { upload: [], execute: [], poll: [], getResult: [] };
  return {
    calls,
    deps: {
      async uploadFile(p) {
        calls.upload.push(p);
        return { status: "success", oss_url: `oss://uploaded/${p.split("/").pop()}` };
      },
      async execute(input) {
        calls.execute.push(input);
        const fn = opts.execute ?? (() => ({ status: "success", outputOssUrls: ["oss://out/result.json"] }));
        return fn(input, calls.execute.length);
      },
      async pollStatus(h) {
        calls.poll.push(h);
        const fn = opts.poll ?? (() => ({ status: "success", outputOssUrls: ["oss://out/da.json"] }));
        return fn(h, calls.poll.length);
      },
      async getResult(u) {
        calls.getResult.push(u);
        return { oss_url: u, detected_as: "json", size_bytes: 10, preview: "{}" };
      },
    },
  };
}

test("single REST step runs inline to success", async () => {
  const m = manifest({
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", depends_on: [] }],
  });
  const { deps, calls } = mockDeps();
  const res = await runWorkflow(m, {}, undefined, deps);
  assert.equal(res.status, "success");
  assert.equal(res.steps_completed, 1);
  assert.equal(calls.execute.length, 1);
  assert.equal(res.results.length, 1, "terminal output previewed");
});

test("uploads a file input once and substitutes the oss url into input_file_url", async () => {
  const m = manifest({
    inputs: [{ key: "dwg_file", type: "file_path", required: true, prompt: "p" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", input_file_url: "{{dwg_file}}", depends_on: [] }],
  });
  const { deps, calls } = mockDeps();
  const res = await runWorkflow(m, { dwg_file: "~/Downloads/x.dwg" }, undefined, deps);
  assert.equal(res.status, "success");
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.execute[0].input_file_url, "oss://uploaded/x.dwg", "uploaded url threaded in");
});

test("substitutes enum/string inputs into args", async () => {
  const m = manifest({
    inputs: [{ key: "fmt", type: "enum", required: false, default: "csv", values: ["csv", "json"], prompt: "p" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", args: { format: "{{fmt}}" }, depends_on: [] }],
  });
  const { deps, calls } = mockDeps();
  const res = await runWorkflow(m, { fmt: "json" }, undefined, deps);
  assert.equal(res.status, "success");
  assert.equal(calls.execute[0].args.format, "json");
});

test("async DA step yields a run_handle, then resumes to success", async () => {
  const m = manifest({
    inputs: [{ key: "f", type: "file_path", required: true, prompt: "p" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", input_file_url: "{{f}}", depends_on: [] }],
  });
  const { deps, calls } = mockDeps({
    execute: () => ({ status: "pending", workflow_handle: { type: "da_workitem", workItemId: "w1", outputOssUrls: [] } }),
    poll: () => ({ status: "success", outputOssUrls: ["oss://out/da.json"] }),
  });
  const first = await runWorkflow(m, { f: "~/x.dwg" }, undefined, deps);
  assert.equal(first.status, "pending");
  assert.equal(first.current_step, "s1");
  assert.ok(first.run_handle, "run_handle returned");

  const second = await runWorkflow(m, {}, first.run_handle, deps);
  assert.equal(second.status, "success");
  assert.equal(calls.poll.length, 1);
  assert.deepEqual(second.outputs[0].oss_urls, ["oss://out/da.json"]);
});

test("threads a prior step's produces output into a downstream input_file_url", async () => {
  const m = manifest({
    steps: [
      { id: "s1", capability_id: "cap", operation_id: "make", produces: "intermediate", depends_on: [] },
      { id: "s2", capability_id: "cap", operation_id: "consume", input_file_url: "intermediate", depends_on: ["s1"] },
    ],
  });
  let n = 0;
  const { deps, calls } = mockDeps({
    execute: () => {
      n++;
      return { status: "success", outputOssUrls: [`oss://out/step${n}.json`] };
    },
  });
  const res = await runWorkflow(m, {}, undefined, deps);
  assert.equal(res.status, "success");
  assert.equal(calls.execute.length, 2);
  assert.equal(calls.execute[1].input_file_url, "oss://out/step1.json", "s2 consumed s1's output");
});

test("missing required input → error", async () => {
  const m = manifest({
    inputs: [{ key: "f", type: "file_path", required: true, prompt: "need a file" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", input_file_url: "{{f}}", depends_on: [] }],
  });
  const { deps } = mockDeps();
  const res = await runWorkflow(m, {}, undefined, deps);
  assert.equal(res.status, "error");
  assert.match(res.error, /Missing required input 'f'/);
});

test("invalid enum value → error", async () => {
  const m = manifest({
    inputs: [{ key: "fmt", type: "enum", required: true, values: ["csv", "json"], prompt: "p" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", args: { f: "{{fmt}}" }, depends_on: [] }],
  });
  const { deps } = mockDeps();
  const res = await runWorkflow(m, { fmt: "pdf" }, undefined, deps);
  assert.equal(res.status, "error");
  assert.match(res.error, /not one of/);
});

test("a failed step surfaces failed status + reportUrl", async () => {
  const m = manifest({ steps: [{ id: "s1", capability_id: "cap", operation_id: "op", depends_on: [] }] });
  const { deps } = mockDeps({
    execute: () => ({ status: "failed", error: "boom", reportUrl: "https://report" }),
  });
  const res = await runWorkflow(m, {}, undefined, deps);
  assert.equal(res.status, "failed");
  assert.equal(res.reportUrl, "https://report");
});

test("depends_on referencing an unknown step → error", async () => {
  const m = manifest({
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", depends_on: ["ghost"] }],
  });
  const { deps } = mockDeps();
  const res = await runWorkflow(m, {}, undefined, deps);
  assert.equal(res.status, "error");
  assert.match(res.error, /unknown step 'ghost'/);
});

// ── manifest-store ────────────────────────────────────────────────────────
test("loadManifest + listManifests round-trip a saved workflow.json", async () => {
  const dir = mkdtempSync(join(homedir(), ".wfb-store-test-"));
  try {
    const m = manifest({ slug: "alpha", name: "Alpha", inputs: [{ key: "f", type: "file_path", required: true, prompt: "p" }],
      steps: [{ id: "s1", capability_id: "cap", operation_id: "op", depends_on: [] }] });
    mkdirSync(join(dir, "alpha"));
    writeFileSync(join(dir, "alpha", "workflow.json"), JSON.stringify(m), "utf8");
    // a non-workflow skill dir should be ignored
    mkdirSync(join(dir, "not-a-workflow"));
    writeFileSync(join(dir, "not-a-workflow", "SKILL.md"), "# hi", "utf8");

    const loaded = loadManifest("alpha", dir);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.manifest.slug, "alpha");

    const list = listManifests(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].slug, "alpha");
    assert.equal(list[0].step_count, 1);

    const missing = loadManifest("nope", dir);
    assert.equal(missing.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
