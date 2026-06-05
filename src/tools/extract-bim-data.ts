import { z } from "zod";
import { existsSync } from "fs";
import { basename } from "path";
import { execSync } from "child_process";

// ── Schema ─────────────────────────────────────────────────────────────────

const DEFAULT_BIM_FILE = process.env.BIM_DEFAULT_FILE ?? "";
const BIM_DATA_DIR = process.env.BIM_DATA_DIR ?? "";

export const extractBimDataSchema = z.object({
  file_path: z.string().optional().describe(
    "Full local Mac path to an Excel (.xlsx/.xls) or JSON file containing Revit element parameters. " +
    "If omitted, falls back to the BIM_DEFAULT_FILE env var set in Claude Desktop config. " +
    "E.g. ~/Downloads/model.xlsx or /Users/you/Work Items/model.xlsx"
  ),
  model_name: z.string().optional().describe(
    "Override the model name shown in the dashboard. Defaults to the filename without extension."
  ),
});

export type ExtractBimDataInput = z.infer<typeof extractBimDataSchema>;

// ── Output ─────────────────────────────────────────────────────────────────

export interface BimElement {
  element_id: number | null;
  category: string | null;
  family: string | null;
  family_type: string | null;
  level: string | null;
  phase_created: string | null;
  comments: string | null;
  mark: string | null;
  area: number | null;
  volume: number | null;
  length: number | null;
  structural: boolean | null;
}

export interface ExtractBimDataOutput {
  status: "success" | "error";
  model_name: string;
  file_path: string;
  total_elements: number;
  categories: Record<string, number>;
  levels: Record<string, number>;
  elements_with_comments: number;
  structural_count: number;
  elements: BimElement[];
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveHome(p: string): string {
  return p.startsWith("~/") ? p.replace("~/", process.env.HOME + "/") : p;
}

function colIdx(headers: (string | null | undefined)[], name: string): number {
  return headers.findIndex(h => h === name);
}

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const s = String(val).replace(/[^\d.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleExtractBimData(input: ExtractBimDataInput): Promise<ExtractBimDataOutput> {
  // Resolve file path: explicit → BIM_DATA_DIR (latest file) → BIM_DEFAULT_FILE fallback
  let rawPath = input.file_path || "";
  if (!rawPath && BIM_DATA_DIR) {
    // Pick the most recently modified .xlsx/.xls/.json in the BIM_Data dir
    try {
      const { readdirSync, statSync } = await import("fs");
      const dir = resolveHome(BIM_DATA_DIR);
      const files = readdirSync(dir)
        .filter(f => /\.(xlsx|xls|json)$/i.test(f))
        .map(f => ({ name: f, mtime: statSync(`${dir}/${f}`).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) rawPath = `${dir}/${files[0].name}`;
    } catch { /* fall through */ }
  }
  if (!rawPath) rawPath = DEFAULT_BIM_FILE;
  if (!rawPath) {
    return { status: "error", error: "No file found. Drop an .xlsx/.xls/.json file in /Users/yedekan/Design_Files/BIM_Data or provide a file_path.", model_name: "", file_path: "", total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
  }

  const filePath = resolveHome(rawPath);
  if (!existsSync(filePath)) {
    return { status: "error", error: `File not found: ${filePath}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
  }

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  let rawRows: (string | null)[][];

  if (ext === "json") {
    // JSON: expect array of objects — convert to header+rows format
    const pyScript = `
import json, sys
data = json.load(open(sys.argv[1]))
if not data: print(json.dumps([])); exit()
headers = list(data[0].keys())
rows = [[str(r.get(h)) if r.get(h) is not None else None for h in headers] for r in data]
print(json.dumps([headers] + rows))
`.trim();
    try {
      const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}' '${filePath.replace(/'/g, "'\\''")}'`, { maxBuffer: 50 * 1024 * 1024 });
      rawRows = JSON.parse(output.toString());
    } catch (e) {
      return { status: "error", error: `Failed to read JSON: ${String(e)}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
    }
  } else {
    // Excel: .xlsx or .xls — use openpyxl (.xlsx) or xlrd (.xls)
    const pyScript = ext === "xls"
      ? `
import xlrd, json, sys
wb = xlrd.open_workbook(sys.argv[1])
ws = wb.sheet_by_index(0)
rows = [ws.row_values(i) for i in range(ws.nrows)]
print(json.dumps([[str(c) if c is not None and c != '' else None for c in r] for r in rows]))
`.trim()
      : `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
print(json.dumps([[str(c) if c is not None else None for c in r] for r in rows]))
`.trim();

    try {
      const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}' '${filePath.replace(/'/g, "'\\''")}'`, { maxBuffer: 50 * 1024 * 1024 });
      rawRows = JSON.parse(output.toString());
    } catch (e) {
      return { status: "error", error: `Failed to read Excel: ${String(e)}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
    }
  }

  if (rawRows.length < 2) {
    return { status: "error", error: "Excel file appears empty or has no data rows.", model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
  }

  const headers = rawRows[0];
  const dataRows = rawRows.slice(1);

  const iCategory     = colIdx(headers, "Category");
  const iElementId    = colIdx(headers, "ElementId");
  const iFamilyType   = colIdx(headers, "FamilyType");
  const iFamily       = colIdx(headers, "Family");
  const iLevel        = colIdx(headers, "Base Constraint") >= 0 ? colIdx(headers, "Base Constraint") : colIdx(headers, "Level");
  const iPhase        = colIdx(headers, "Phase Created");
  const iComments     = colIdx(headers, "Comments");
  const iMark         = colIdx(headers, "Mark");
  const iArea         = colIdx(headers, "Area");
  const iVolume       = colIdx(headers, "Volume");
  const iLength       = colIdx(headers, "Length");
  const iStructural   = colIdx(headers, "Structural");

  const elements: BimElement[] = [];
  const categories: Record<string, number> = {};
  const levels: Record<string, number> = {};
  let commentsCount = 0;
  let structuralCount = 0;

  for (const row of dataRows) {
    const cat = iCategory >= 0 ? row[iCategory] : null;
    const lvl = iLevel >= 0 ? row[iLevel] : null;
    const comments = iComments >= 0 ? row[iComments] : null;
    const structVal = iStructural >= 0 ? (row[iStructural] ?? "").toLowerCase() : "";
    const structural = structVal === "yes" ? true : structVal === "no" ? false : null;

    if (cat) categories[cat] = (categories[cat] ?? 0) + 1;
    if (lvl) levels[lvl] = (levels[lvl] ?? 0) + 1;
    if (comments) commentsCount++;
    if (structural === true) structuralCount++;

    const elemId = iElementId >= 0 ? row[iElementId] : null;
    elements.push({
      element_id: elemId ? parseInt(elemId, 10) || null : null,
      category: cat,
      family: iFamily >= 0 ? row[iFamily] : null,
      family_type: iFamilyType >= 0 ? row[iFamilyType] : null,
      level: lvl,
      phase_created: iPhase >= 0 ? row[iPhase] : null,
      comments,
      mark: iMark >= 0 ? row[iMark] : null,
      area: iArea >= 0 ? safeNum(row[iArea]) : null,
      volume: iVolume >= 0 ? safeNum(row[iVolume]) : null,
      length: iLength >= 0 ? safeNum(row[iLength]) : null,
      structural,
    });
  }

  const modelName = input.model_name ?? basename(filePath, ".xlsx").replace(/_/g, " ");

  return {
    status: "success",
    model_name: modelName,
    file_path: filePath,
    total_elements: elements.length,
    categories,
    levels,
    elements_with_comments: commentsCount,
    structural_count: structuralCount,
    elements,
  };
}
