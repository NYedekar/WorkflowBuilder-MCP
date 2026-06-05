import { z } from "zod";
import { existsSync } from "fs";
import { basename } from "path";
import { execSync } from "child_process";
// ── Schema ─────────────────────────────────────────────────────────────────
export const extractBimDataSchema = z.object({
    file_path: z.string().describe("Full local Mac path to an Excel (.xlsx) file containing Revit element parameters. " +
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
    const filePath = resolveHome(input.file_path);
    if (!existsSync(filePath)) {
        return { status: "error", error: `File not found: ${filePath}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
    }
    // Use Python + openpyxl to read the Excel file (avoids xlsx npm dependency)
    const pyScript = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
print(json.dumps([[str(c) if c is not None else None for c in r] for r in rows]))
`.trim();
    let rawRows;
    try {
        const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}' '${filePath.replace(/'/g, "'\\''")}'`, { maxBuffer: 50 * 1024 * 1024 });
        rawRows = JSON.parse(output.toString());
    }
    catch (e) {
        return { status: "error", error: `Failed to read Excel: ${String(e)}`, model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
    }
    if (rawRows.length < 2) {
        return { status: "error", error: "Excel file appears empty or has no data rows.", model_name: "", file_path: filePath, total_elements: 0, categories: {}, levels: {}, elements_with_comments: 0, structural_count: 0, elements: [] };
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
