// Tests for the experimental MCP Apps "Save as skill" button (offer_save_skill_button + UI).
import { test } from "node:test";
import assert from "node:assert/strict";

import { handleOfferSaveSkillButton, offerSaveSkillButtonSchema } from "../dist/tools/offer-save-skill-button.js";
import { SAVE_SKILL_UI_HTML, SAVE_SKILL_UI_URI, MCP_APP_MIME } from "../dist/lib/save-skill-ui.js";

test("handler returns structuredContent carrying the recipe + slug hint", () => {
  const input = offerSaveSkillButtonSchema.parse({
    name: "DWG Layer Report",
    intent: "extract layers",
    inputs: [{ key: "dwg_file", type: "file_path", required: true, prompt: "the dwg" }],
    steps: [{ id: "s1", capability_id: "cap", operation_id: "op", input_file_url: "{{dwg_file}}", depends_on: [] }],
  });
  const res = handleOfferSaveSkillButton(input);
  assert.equal(res.structuredContent.name, "DWG Layer Report");
  assert.equal(res.structuredContent.slug_hint, "dwg-layer-report");
  assert.equal(res.structuredContent.steps.length, 1);
  assert.ok(Array.isArray(res.content) && res.content[0].type === "text");
});

test("UI resource constants and HTML are well-formed", () => {
  assert.equal(SAVE_SKILL_UI_URI, "ui://workflow-builder/save-skill");
  assert.equal(MCP_APP_MIME, "text/html;profile=mcp-app");
  assert.ok(SAVE_SKILL_UI_HTML.startsWith("<!DOCTYPE html>"));
  // calls back the real tool via JSON-RPC over postMessage
  assert.match(SAVE_SKILL_UI_HTML, /method: 'tools\/call'/);
  assert.match(SAVE_SKILL_UI_HTML, /save_workflow_as_skill/);
  // consumes the tool-result structuredContent
  assert.match(SAVE_SKILL_UI_HTML, /ui\/notifications\/tool-result/);
});
