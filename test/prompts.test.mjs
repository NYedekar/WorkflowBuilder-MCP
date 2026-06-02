// Tests for Phase-3 MCP prompts (saved workflows as slash commands).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { buildPromptList, buildPromptMessages } from "../dist/lib/prompt-builder.js";
import { workflowManifestSchema } from "../dist/lib/skill-manifest.js";

function seedSkillsDir() {
  const dir = mkdtempSync(join(homedir(), ".wfb-prompts-test-"));
  const m = workflowManifestSchema.parse({
    schema_version: 1,
    name: "DWG Layer Report",
    slug: "dwg-layer-report",
    intent: "Extract a layer report from a DWG to JSON.",
    description: "d",
    auth_mode: "2LO",
    inputs: [{ key: "dwg_file", type: "file_path", required: true, prompt: "Path to the .dwg" }],
    steps: [{ id: "s1", capability_id: "autocad:AutoCADLayerReport", operation_id: "extract-layer-report", input_file_url: "{{dwg_file}}", depends_on: [] }],
    created_at: "2026-06-01T00:00:00.000Z",
    generator: "test",
  });
  mkdirSync(join(dir, "dwg-layer-report"));
  writeFileSync(join(dir, "dwg-layer-report", "workflow.json"), JSON.stringify(m), "utf8");
  return dir;
}

test("buildPromptList exposes one prompt per saved workflow with its inputs as arguments", () => {
  const dir = seedSkillsDir();
  try {
    const prompts = buildPromptList(dir);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].name, "dwg-layer-report");
    assert.match(prompts[0].description, /Run saved workflow: DWG Layer Report/);
    assert.equal(prompts[0].arguments.length, 1);
    assert.equal(prompts[0].arguments[0].name, "dwg_file");
    assert.equal(prompts[0].arguments[0].required, true);
    assert.match(prompts[0].arguments[0].description, /Mac path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPromptMessages injects a run_saved_workflow instruction with the provided input", () => {
  const dir = seedSkillsDir();
  try {
    const res = buildPromptMessages("dwg-layer-report", { dwg_file: "~/Downloads/x.dwg" }, dir);
    const text = res.messages[0].content.text;
    assert.match(text, /run_saved_workflow\(slug="dwg-layer-report"/);
    assert.match(text, /~\/Downloads\/x\.dwg/);
    assert.equal(res.messages[0].role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPromptMessages flags a missing required input", () => {
  const dir = seedSkillsDir();
  try {
    const res = buildPromptMessages("dwg-layer-report", {}, dir);
    assert.match(res.messages[0].content.text, /MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPromptMessages throws on an unknown prompt name", () => {
  const dir = seedSkillsDir();
  try {
    assert.throws(() => buildPromptMessages("ghost", {}, dir), /Unknown saved workflow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
