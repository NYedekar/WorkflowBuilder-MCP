// Functional tests for save_workflow_as_skill — runs against the real capability registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { handleSaveWorkflowAsSkill, saveWorkflowAsSkillSchema } from "../dist/tools/save-workflow-as-skill.js";
import { getCapabilityIndex } from "../dist/lib/registry-client.js";

// Mirror the production dispatch path (index.ts parses args through the schema, applying defaults).
const run = (input) => handleSaveWorkflowAsSkill(saveWorkflowAsSkillSchema.parse(input));

// Pick a real callable capability + operation so the test tracks the live registry.
function pickCallable() {
  for (const cap of getCapabilityIndex()) {
    const op = cap.operations.find((o) => o.callable !== false);
    if (op) return { capability_id: cap.id, operation_id: op.operationId };
  }
  throw new Error("No callable capability found in registry — cannot run test.");
}

function tmpSkillsDir() {
  // Must live under $HOME (handler rejects paths outside home).
  return mkdtempSync(join(homedir(), ".wfb-skill-test-"));
}

test("happy path: writes SKILL.md + workflow.json and templates inputs", async () => {
  const dir = tmpSkillsDir();
  try {
    const { capability_id, operation_id } = pickCallable();
    const res = await run({
      name: "Extract Room Data Test",
      intent: "Extract room data from a Revit file and save as CSV.",
      auth_mode: "auto",
      inputs: [
        { key: "input_file", type: "file_path", required: true, prompt: "Path to the .rvt file" },
        { key: "fmt", type: "enum", required: false, default: "csv", values: ["csv", "json"], prompt: "Output format" },
      ],
      steps: [
        {
          id: "s1",
          capability_id,
          operation_id,
          input_file_url: "{{input_file}}",
          args: { format: "{{fmt}}" },
          depends_on: [],
          produces: "rooms",
        },
      ],
      overwrite: false,
      skills_dir: dir,
    });

    assert.equal(res.status, "success", JSON.stringify(res));
    assert.equal(res.slug, "extract-room-data-test");
    assert.equal(res.invoke_hint, "/extract-room-data-test");
    assert.ok(existsSync(res.skill_md), "SKILL.md written");
    assert.ok(existsSync(res.manifest_path), "workflow.json written");

    const md = readFileSync(res.skill_md, "utf8");
    assert.match(md, /^---\nname: extract-room-data-test\n/, "frontmatter slug");
    assert.match(md, /\{\{input_file\}\}/, "placeholder preserved in recipe");

    const manifest = JSON.parse(readFileSync(res.manifest_path, "utf8"));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.steps[0].capability_id, capability_id);
    assert.equal(manifest.steps[0].produces, "rooms");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an unregistered capability_id", async () => {
  const dir = tmpSkillsDir();
  try {
    const res = await run({
      name: "Bad Cap",
      intent: "x",
      steps: [{ id: "s1", capability_id: "Totally__Not__Real", operation_id: "nope", depends_on: [] }],
      skills_dir: dir,
    });
    assert.equal(res.status, "error");
    assert.match(res.error, /not found in the registry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a placeholder not declared in inputs", async () => {
  const dir = tmpSkillsDir();
  try {
    const { capability_id, operation_id } = pickCallable();
    const res = await run({
      name: "Undeclared PH",
      intent: "x",
      inputs: [],
      steps: [{ id: "s1", capability_id, operation_id, input_file_url: "{{missing}}", depends_on: [] }],
      skills_dir: dir,
    });
    assert.equal(res.status, "error");
    assert.match(res.error, /not declared in inputs/);
    assert.match(res.error, /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects secret-looking args (secret hygiene)", async () => {
  const dir = tmpSkillsDir();
  try {
    const { capability_id, operation_id } = pickCallable();
    const res = await run({
      name: "Leaky",
      intent: "x",
      steps: [{ id: "s1", capability_id, operation_id, args: { bearer_token: "abc123" }, depends_on: [] }],
      skills_dir: dir,
    });
    assert.equal(res.status, "error");
    assert.match(res.error, /secret-like/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing skill unless overwrite=true", async () => {
  const dir = tmpSkillsDir();
  try {
    const { capability_id, operation_id } = pickCallable();
    const base = {
      name: "Dup Flow",
      intent: "x",
      steps: [{ id: "s1", capability_id, operation_id, depends_on: [] }],
      skills_dir: dir,
    };
    const first = await run({ ...base });
    assert.equal(first.status, "success");

    const second = await run({ ...base });
    assert.equal(second.status, "error");
    assert.match(second.error, /already exists/);

    const third = await run({ ...base, overwrite: true });
    assert.equal(third.status, "success");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
