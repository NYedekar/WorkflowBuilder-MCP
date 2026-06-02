// Tests for export_skill_for_claude (claude.ai-ready ZIP packaging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

import { handleExportSkillForClaude } from "../dist/tools/export-skill-zip.js";
import { workflowManifestSchema } from "../dist/lib/skill-manifest.js";

function seed() {
  const skillsDir = mkdtempSync(join(homedir(), ".wfb-zip-skills-"));
  const outDir = mkdtempSync(join(homedir(), ".wfb-zip-out-"));
  const m = workflowManifestSchema.parse({
    schema_version: 1, name: "Zip Me", slug: "zip-me", intent: "x", description: "d",
    auth_mode: "2LO", inputs: [], steps: [{ id: "s1", capability_id: "cap", operation_id: "op", depends_on: [] }],
    created_at: "2026-06-01T00:00:00.000Z", generator: "test",
  });
  mkdirSync(join(skillsDir, "zip-me"));
  writeFileSync(join(skillsDir, "zip-me", "workflow.json"), JSON.stringify(m), "utf8");
  writeFileSync(join(skillsDir, "zip-me", "SKILL.md"), "---\nname: zip-me\ndescription: d\n---\n# Zip Me\n", "utf8");
  return { skillsDir, outDir };
}

test("packages a saved skill into a ZIP with the folder as root", async () => {
  const { skillsDir, outDir } = seed();
  try {
    const res = await handleExportSkillForClaude({ slug: "zip-me", output_dir: outDir, skills_dir: skillsDir });
    assert.equal(res.status, "success", JSON.stringify(res));
    assert.ok(existsSync(res.zip_path), "zip written");
    assert.ok(statSync(res.zip_path).size > 0, "zip non-empty");
    assert.match(res.upload_url, /claude\.ai\/customize\/skills/);
    // Verify archive root is the slug folder containing SKILL.md
    const listing = execFileSync("unzip", ["-l", res.zip_path], { encoding: "utf8" });
    assert.match(listing, /zip-me\/SKILL\.md/);
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("errors on an unknown slug", async () => {
  const { skillsDir, outDir } = seed();
  try {
    const res = await handleExportSkillForClaude({ slug: "nope", output_dir: outDir, skills_dir: skillsDir });
    assert.equal(res.status, "error");
    assert.match(res.error, /No saved workflow named 'nope'/);
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
