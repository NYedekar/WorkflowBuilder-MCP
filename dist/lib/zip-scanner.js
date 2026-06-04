// Minimal ZIP central-directory reader — no external dependencies.
// Scans a local zip file to find Inventor root assembly (.iam) candidates.
//
// Root assembly heuristic: filter .iam entries (excluding __MACOSX/ metadata),
// then pick the largest by uncompressed size. Sub-assemblies are always smaller
// than the top-level assembly that references them.
import { readFileSync } from "fs";
function readCentralDirectory(buf) {
    // ZIP end-of-central-directory (EOCD) signature: 0x06054b50
    const EOCD_SIG = 0x06054b50;
    let eocdOffset = -1;
    // Scan backwards from end (comment can be up to 65535 bytes, so search up to 65557 bytes from end)
    const searchStart = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= searchStart; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1)
        return [];
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    // ZIP64 sentinel: if either is 0xFFFFFFFF the file needs ZIP64 EOCD — skip for now
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff)
        return [];
    const entries = [];
    const CD_SIG = 0x02014b50;
    let pos = cdOffset;
    while (pos + 46 <= cdOffset + cdSize && pos + 46 <= buf.length) {
        if (buf.readUInt32LE(pos) !== CD_SIG)
            break;
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const fnLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        if (pos + 46 + fnLen > buf.length)
            break;
        const name = buf.toString("utf8", pos + 46, pos + 46 + fnLen);
        entries.push({ name, uncompressedSize });
        pos += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
}
/**
 * Scans a local zip file and returns the path to the root Inventor assembly (.iam).
 * Returns null if no .iam files are found or the file is not a valid zip.
 *
 * When multiple .iam files are present, returns the largest one (root assemblies
 * are always larger than the sub-assemblies they reference).
 */
export function findRootIamInZip(zipPath) {
    let buf;
    try {
        buf = readFileSync(zipPath);
    }
    catch {
        return null;
    }
    let entries;
    try {
        entries = readCentralDirectory(buf);
    }
    catch {
        return null;
    }
    const iamEntries = entries.filter((e) => e.name.toLowerCase().endsWith(".iam") &&
        !e.name.startsWith("__MACOSX/"));
    if (iamEntries.length === 0)
        return null;
    if (iamEntries.length === 1)
        return iamEntries[0].name;
    // Multiple .iam files — root assembly is the largest
    iamEntries.sort((a, b) => b.uncompressedSize - a.uncompressedSize);
    return iamEntries[0].name;
}
