import { z } from "zod";
import { existsSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { execSync } from "child_process";
import { tmpdir } from "os";
// ── Schema ─────────────────────────────────────────────────────────────────
const DEFAULT_BIM_FILE = process.env.BIM_DEFAULT_FILE ?? "";
const BIM_DATA_DIR = process.env.BIM_DATA_DIR ?? "";
export const extractBimDataSchema = z.object({
    file_path: z.string().optional().describe("Full local Mac path to an Excel (.xlsx/.xls) or JSON file containing Revit element parameters. " +
        "If omitted, falls back to the BIM_DEFAULT_FILE env var set in Claude Desktop config. " +
        "E.g. ~/Downloads/model.xlsx or /Users/you/Work Items/model.xlsx"),
    model_name: z.string().optional().describe("Override the model name shown in the dashboard. Defaults to the filename without extension."),
});
// ── Helpers ────────────────────────────────────────────────────────────────
function resolveHome(p) {
    return p.startsWith("~/") ? p.replace("~/", process.env.HOME + "/") : p;
}
function colIdx(headers, name) {
    return headers.findIndex(h => h === name);
}
function safeNum(val) {
    if (val === null || val === undefined || val === "")
        return null;
    const s = String(val).replace(/[^\d.-]/g, "");
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}
// ── Handler ────────────────────────────────────────────────────────────────
export async function handleExtractBimData(input) {
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
            if (files.length > 0)
                rawPath = `${dir}/${files[0].name}`;
        }
        catch { /* fall through */ }
    }
    if (!rawPath)
        rawPath = DEFAULT_BIM_FILE;
    if (!rawPath) {
        return { status: "error", error: "No file found. Drop an .xlsx/.xls/.json file in /Users/yedekan/Design_Files/BIM_Data or provide a file_path.", model_name: "", file_path: "", total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, data_file: "" };
    }
    const filePath = resolveHome(rawPath);
    if (!existsSync(filePath)) {
        return { status: "error", error: `File not found: ${filePath}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, data_file: "" };
    }
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    let rawRows;
    if (ext === "json") {
        // JSON: handles two formats:
        //   1. Flat array of objects: [{...}, {...}]  (simple case)
        //   2. Nested RevitExtractor format: {"ProjectInfo":{}, "Categories":{"Walls":[{...}], ...}}
        const pyScript = `
import json, sys

def flatten_revit_extractor(data):
    """Flatten the nested RevitExtractor JSON format into a flat array of element dicts."""
    elements = []
    categories = data.get('Categories', {})
    for cat_name, items in categories.items():
        if not isinstance(items, list):
            continue
        for item in items:
            # RevitExtractor format: root has ElementId + FamilyType,
            # params live in InstanceParameters (preferred) and TypeParameters (fallback)
            inst = item.get('InstanceParameters', item.get('instanceParameters', {}))
            typ  = item.get('TypeParameters',    item.get('typeParameters',    {}))
            # Merge: instance values take precedence over type values; both override root
            params = {**typ, **inst}
            elem = {
                'Category':     cat_name,
                'ElementId':    item.get('ElementId') or item.get('elementId'),
                'Family':       inst.get('Family') or inst.get('family') or typ.get('Family'),
                'FamilyType':   item.get('FamilyType') or item.get('familyType') or params.get('Type Name'),
                'Level':        params.get('Base Constraint') or params.get('Level') or params.get('level'),
                'Phase Created':params.get('Phase Created') or params.get('phaseCreated'),
                'Comments':     params.get('Comments') or params.get('comments'),
                'Mark':         params.get('Mark') or params.get('mark'),
                'Area':         params.get('Area') or params.get('area'),
                'Volume':       params.get('Volume') or params.get('volume'),
                'Length':       params.get('Length') or params.get('length'),
                'Structural':   params.get('Structural') or params.get('structural'),
            }
            elements.append(elem)
    return elements

data = json.load(open(sys.argv[1]))

# Detect format
if isinstance(data, list):
    elements = data
elif isinstance(data, dict) and 'Categories' in data:
    elements = flatten_revit_extractor(data)
elif isinstance(data, dict):
    # Try to find any list value that looks like elements
    for v in data.values():
        if isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
            elements = v
            break
    else:
        elements = []
else:
    elements = []

if not elements:
    print(json.dumps([]))
    exit()

headers = list(elements[0].keys())
rows = [[str(r.get(h)) if r.get(h) is not None else None for h in headers] for r in elements]
print(json.dumps([headers] + rows))
`.trim();
        try {
            const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}' '${filePath.replace(/'/g, "'\\''")}'`, { maxBuffer: 50 * 1024 * 1024 });
            rawRows = JSON.parse(output.toString());
        }
        catch (e) {
            return { status: "error", error: `Failed to read JSON: ${String(e)}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, data_file: "" };
        }
    }
    else {
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
        }
        catch (e) {
            return { status: "error", error: `Failed to read Excel: ${String(e)}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, data_file: "" };
        }
    }
    if (rawRows.length < 2) {
        return { status: "error", error: "Excel file appears empty or has no data rows.", model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, data_file: "" };
    }
    const headers = rawRows[0];
    const dataRows = rawRows.slice(1);
    const iCategory = colIdx(headers, "Category");
    const iElementId = colIdx(headers, "ElementId");
    const iFamilyType = colIdx(headers, "FamilyType");
    const iFamily = colIdx(headers, "Family");
    const iLevel = colIdx(headers, "Base Constraint") >= 0 ? colIdx(headers, "Base Constraint") : colIdx(headers, "Level");
    const iPhase = colIdx(headers, "Phase Created");
    const iComments = colIdx(headers, "Comments");
    const iMark = colIdx(headers, "Mark");
    const iArea = colIdx(headers, "Area");
    const iVolume = colIdx(headers, "Volume");
    const iLength = colIdx(headers, "Length");
    const iStructural = colIdx(headers, "Structural");
    const elements = [];
    const categories = {};
    const levels = {};
    let commentsCount = 0;
    let structuralCount = 0;
    for (const row of dataRows) {
        const cat = iCategory >= 0 ? row[iCategory] : null;
        const lvl = iLevel >= 0 ? row[iLevel] : null;
        const comments = iComments >= 0 ? row[iComments] : null;
        const structVal = iStructural >= 0 ? (row[iStructural] ?? "").toLowerCase() : "";
        const structural = structVal === "yes" ? true : structVal === "no" ? false : null;
        if (cat)
            categories[cat] = (categories[cat] ?? 0) + 1;
        if (lvl)
            levels[lvl] = (levels[lvl] ?? 0) + 1;
        if (comments)
            commentsCount++;
        if (structural === true)
            structuralCount++;
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
    const modelName = input.model_name ?? basename(filePath).replace(/\.[^.]+$/, "").replace(/_/g, " ");
    // Write elements to a temp file — avoids passing 100s of KB through tool args
    const dataFile = join(tmpdir(), `bim_extract_${Date.now()}.json`);
    writeFileSync(dataFile, JSON.stringify(elements), "utf-8");
    return {
        status: "success",
        model_name: modelName,
        file_path: filePath,
        total_elements: elements.length,
        categories,
        levels,
        elements_with_comments: commentsCount,
        structural_count: structuralCount,
        data_file: dataFile,
    };
}
