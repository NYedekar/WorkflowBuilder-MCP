import { readFileSync, statSync, existsSync } from "fs";
import { basename, extname } from "path";
import { homedir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { z } from "zod";
const execAsync = promisify(exec);
import { resolve3LOCredential, resolveCredential } from "../auth/credential-resolver.js";
import { getSignedS3DownloadUrl, getSignedS3UploadUrl, uploadToS3, finalizeS3Upload, DAError, } from "../lib/da-client.js";
// ── publish_to_acc_folder ───────────────────────────────────────────────────
//
// One-call wrapper for the ACC/BIM360 file-publish chain that previously had to
// be driven by five hand-built execute_workflow calls — the gap that made models
// wander off into a false "ACC buckets are write-protected by design" dead-end.
//
// The real flow (all standard, all supported with a project-member token):
//   1. create_storage         POST /data/v1/projects/{project}/storage     → WIP object URN
//   2. get_signed_s3_upload    GET  /oss/v2/.../signeds3upload              → signed PUT URL(s)
//   3. PUT bytes to S3
//   4. finalize_signed_s3_upload POST /oss/v2/.../signeds3upload            → commit object
//   5. create_item             POST /data/v1/projects/{project}/items       → file in folder
//
// Source bytes come from one of: an existing OSS object (e.g. a Design Automation
// output — the common case after a conversion), a local Mac file, or an HTTPS URL.
//
// Writing into an ACC Docs folder needs a USER identity, so this requires a 3LO
// token. We do NOT fall back to 2LO: a bare client-credential token can't see or
// write project folders, and silently trying it is exactly what produced the
// misleading "app isn't provisioned" diagnosis. Fail loud, point at the fix.
const DM_BASE = "https://developer.api.autodesk.com/data/v1";
const PUBLISH_3LO_SCOPES = ["data:read", "data:write", "data:create"];
export const publishToAccFolderSchema = z
    .object({
    project_id: z
        .string()
        .optional()
        .describe("ACC/BIM360 project id, e.g. 'b.ec81e371-8332-4663-a0fe-1a9579465bd1' (the 'b.' prefix is expected). " +
        "Provide project_id OR project_name. With project_id + hub_id the tool skips all hub/project lookups."),
    project_name: z
        .string()
        .optional()
        .describe("Project name to resolve instead of project_id, e.g. 'Demoland Building 1'. The tool lists projects " +
        "(narrowed by hub_id / hub_name / region if given) and matches exactly. Ambiguous matches error with " +
        "the candidates. Provide project_id OR project_name."),
    folder_id: z
        .string()
        .optional()
        .describe("Exact target folder URN to publish into, e.g. 'urn:adsk.wipprod:fs.folder:co.xxxxx'. " +
        "Use this when you already have the id (from list_folder_contents). " +
        "Provide either folder_id OR folder_path (with hub_id), not both."),
    folder_path: z
        .string()
        .optional()
        .describe("Folder path to resolve (and optionally create) instead of an exact id, e.g. " +
        "'Project Files/Converted Models'. Rooted at the project's top folders: if the first segment " +
        "matches a top folder it roots there, otherwise the whole path is treated as a subfolder path " +
        "beneath the default top folder 'Project Files'. A bare name like 'Converted Models' resolves " +
        "under Project Files. Existing folders are REUSED (never duplicated); missing ones are created " +
        "when create_missing is true. Requires hub_id. Top-level folders cannot be created."),
    hub_id: z
        .string()
        .optional()
        .describe("Hub id (e.g. 'b.ba36cdef-...'), from list_hubs. Lets the tool skip hub discovery. " +
        "Needed (directly or resolvable via hub_name/region/project_name) when using folder_path, " +
        "since top folders are reached through the hub. Not needed when passing folder_id directly."),
    hub_name: z
        .string()
        .optional()
        .describe("Hub name to narrow project resolution, e.g. 'Demoland'. Optional — combine with region to " +
        "disambiguate when the same project name exists in multiple hubs."),
    create_missing: z
        .boolean()
        .optional()
        .default(true)
        .describe("When resolving folder_path: create any missing subfolder segments. Default true. " +
        "If false and the folder doesn't exist, the call errors instead of creating it. " +
        "Has no effect when the folder already exists (it's always reused) or when folder_id is used."),
    source_oss_url: z
        .string()
        .optional()
        .describe("oss:// URL of an object already in APS OSS to publish — typically the output of a prior job " +
        "(e.g. a RevitIFCExport result). Format: oss://bucketKey/objectKey. " +
        "Provide exactly one of source_oss_url, file_path, or file_url."),
    file_path: z
        .string()
        .optional()
        .describe("Full path to a local file on this Mac (~/Downloads/, /Users/..., OneDrive paths). " +
        "Provide exactly one of source_oss_url, file_path, or file_url."),
    file_url: z
        .string()
        .url()
        .optional()
        .describe("HTTPS URL to fetch and publish (e.g. a public/sharing link). " +
        "Provide exactly one of source_oss_url, file_path, or file_url."),
    file_name: z
        .string()
        .optional()
        .describe("Display name for the file in ACC (e.g. 'tower.ifc'). " +
        "Defaults to the object/file name derived from the source."),
    if_exists: z
        .enum(["new_version", "error"])
        .optional()
        .default("new_version")
        .describe("What to do when a file with this name already exists in the target folder. " +
        "'new_version' (default) adds a new version to the existing file — matches ACC's drag-and-drop " +
        "behavior, ideal for re-publishing an updated model. 'error' refuses and leaves the file untouched."),
    open_in_browser: z
        .boolean()
        .optional()
        .default(true)
        .describe("On success, open the ACC Docs folder (now containing the file) in the default browser. " +
        "Default true. The web_url is always returned regardless. macOS only (the MCP runs locally)."),
    region: z
        .string()
        .optional()
        .describe("Data-residency region of the hub, sent as x-ads-region on the storage, OSS, and item calls. " +
        "REQUIRED for non-US hubs — a Canadian hub's WIP bucket lives on the CAN shard and the upload " +
        "404s/403s without it. Values: 'CAN', 'EMEA', 'AUS', 'GBR', 'DEU', 'IND', 'JPN'. Omit for US."),
})
    .describe("Publish a file into an ACC/BIM360 project folder in one call: reserves storage, uploads the bytes " +
    "via the OSS signed-S3 flow, and creates the file item. Region-aware. Requires a 3LO token " +
    "(run authenticate_aps_3lo first) because folder writes need a project-member user identity.");
function normalizePath(raw) {
    let p = raw.trim().replace(/^['"]|['"]$/g, "");
    if (p.startsWith("~/") || p === "~")
        p = homedir() + p.slice(1);
    return p;
}
const IFC_LIKE = {
    ".ifc": "application/x-step",
    ".step": "application/x-step",
    ".stp": "application/x-step",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".zip": "application/zip",
};
function detectContentType(filename) {
    return IFC_LIKE[extname(filename).toLowerCase()] ?? "application/octet-stream";
}
// Tolerant name comparison for ACC hub/project/folder/file names. Real ACC data
// routinely carries trailing/leading whitespace (e.g. "Demoland Building 1 ") and
// inconsistent casing — exact === matching silently misses those and forces a
// manual fallback, defeating name resolution. Trim + case-fold both sides.
function nameEq(a, b) {
    return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}
// ACC web app host per data-residency region (region code → hostname).
// Source: Autodesk DOCS "Regional Data Storage" FAQ (help.autodesk.com).
const ACC_WEB_HOSTS = {
    US: "acc.autodesk.com",
    EMEA: "acc.autodesk.eu",
    AUS: "acc.aus.autodesk.com",
    GBR: "acc.gbr.autodesk.com",
    DEU: "acc.deu.autodesk.com",
    CAN: "acc.can.autodesk.com",
    IND: "acc.ind.autodesk.com",
    JPN: "acc.jpn.autodesk.com",
};
// Deep-link to the ACC Docs folder. A Canadian/EMEA/etc. project is ONLY reachable
// on its regional host, so the region must pick the right subdomain — the US host
// won't find a CAN project. project id drops the 'b.' lineage prefix in web URLs.
function accWebHost(region) {
    return (region && ACC_WEB_HOSTS[region.toUpperCase()]) || ACC_WEB_HOSTS.US;
}
// The folder goes in the `folderUrn` QUERY param, NOT a path segment: ACC WIP
// folder ids can contain '/' and '+', and in a path the CDN %2F-decodes them into
// bogus segments → S3 "NoSuchKey". As a query value they survive encoding.
// Format confirmed against a live ACC browser URL:
//   /docs/files/projects/{guid}?folderUrn={enc}&viewModel=detail&moduleId=folders
function accFolderUrl(region, projectId, folderId) {
    const projectGuid = projectId.replace(/^b\./, "");
    const folderUrn = encodeURIComponent(folderId);
    return `https://${accWebHost(region)}/docs/files/projects/${projectGuid}?folderUrn=${folderUrn}&viewModel=detail&moduleId=folders`;
}
// Project files root — guaranteed-valid fallback link (the deep folder path is best-effort).
function accProjectUrl(region, projectId) {
    const projectGuid = projectId.replace(/^b\./, "");
    return `https://${accWebHost(region)}/docs/files/projects/${projectGuid}`;
}
// urn:adsk.objects:os.object:<bucketKey>/<objectKey>  →  { bucketKey, objectKey }
function parseStorageUrn(urn) {
    const prefix = "urn:adsk.objects:os.object:";
    if (!urn.startsWith(prefix))
        return null;
    const remainder = urn.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash < 0)
        return null;
    return { bucketKey: remainder.slice(0, slash), objectKey: remainder.slice(slash + 1) };
}
export async function handlePublishToAccFolder(input) {
    // ── Exactly one source ────────────────────────────────────────────────────
    const sources = [input.source_oss_url, input.file_path, input.file_url].filter(Boolean);
    if (sources.length !== 1) {
        return {
            status: "error",
            error: "Provide exactly one of source_oss_url, file_path, or file_url.",
        };
    }
    // ── Folder target: exactly one of folder_id / folder_path ─────────────────
    if (!input.folder_id && !input.folder_path) {
        return { status: "error", error: "Provide a target folder: either folder_id or folder_path." };
    }
    if (input.folder_id && input.folder_path) {
        return { status: "error", error: "Provide either folder_id or folder_path, not both." };
    }
    // ── Project target: exactly one of project_id / project_name ──────────────
    if (!input.project_id && !input.project_name) {
        return { status: "error", error: "Provide a project: either project_id or project_name." };
    }
    if (input.project_id && input.project_name) {
        return { status: "error", error: "Provide either project_id or project_name, not both." };
    }
    // ── 3LO auth (no 2LO fallback — see header note) ──────────────────────────
    const cred = await resolve3LOCredential(PUBLISH_3LO_SCOPES);
    if (!cred) {
        return {
            status: "error",
            error: "No 3LO (user-identity) token available — ACC folder writes require one.",
            hint: "Run authenticate_aps_3lo first to sign in. A 2LO client-credential token cannot see or write " +
                "project folders unless the app is provisioned as a project member.",
        };
    }
    const token = cred.access_token;
    const region = input.region;
    // ── Resolve hub + project (by id or name) ─────────────────────────────────
    let hubId;
    let projectId;
    try {
        const resolved = await resolveProject({
            projectId: input.project_id,
            projectName: input.project_name,
            hubId: input.hub_id,
            hubName: input.hub_name,
            region,
        }, token);
        hubId = resolved.hubId;
        projectId = resolved.projectId;
    }
    catch (err) {
        if (err instanceof ResolveError)
            return { status: "error", error: err.message, hint: err.hint };
        const e = err;
        return { status: "error", error: `Project resolution failed: ${e.message}` };
    }
    // ── Resolve the target folder (find-or-create from a path) ────────────────
    let folderId;
    let foldersCreated = [];
    if (input.folder_id) {
        folderId = input.folder_id;
    }
    else {
        if (!hubId) {
            return {
                status: "error",
                error: "folder_path needs a hub, which couldn't be determined.",
                hint: "Pass hub_id (or hub_name/region, or use project_name so the hub is resolved), or pass an exact folder_id.",
            };
        }
        try {
            const resolved = await resolveFolderPath(projectId, hubId, input.folder_path, input.create_missing, token, region);
            folderId = resolved.folderId;
            foldersCreated = resolved.created;
        }
        catch (err) {
            if (err instanceof FolderResolveError)
                return { status: "error", error: err.message, hint: err.hint };
            const e = err;
            return { status: "error", error: `Folder resolution failed: ${e.message}` };
        }
    }
    // ── Acquire bytes + filename ──────────────────────────────────────────────
    let fileBuffer;
    let fileName;
    try {
        const acquired = await acquireBytes(input, token);
        fileBuffer = acquired.buffer;
        fileName = input.file_name ?? acquired.name;
    }
    catch (err) {
        if (err instanceof SourceError)
            return { status: "error", error: err.message, hint: err.hint };
        return { status: "error", error: `Could not read source file: ${String(err)}` };
    }
    const fileSizeBytes = fileBuffer.byteLength;
    const contentType = detectContentType(fileName);
    // ── 1. Reserve storage in the project, targeting the folder ───────────────
    let storageUrn;
    try {
        storageUrn = await createStorage(projectId, folderId, fileName, token, region);
    }
    catch (err) {
        const e = err;
        return {
            status: "error",
            error: `create_storage failed: ${e.message}`,
            hint: e.statusCode === 403
                ? "The signed-in user lacks write access to this folder, or the project_id/folder_id don't match this hub."
                : e.statusCode === 404
                    ? "project_id or folder_id not found — re-resolve them via list_hub_projects / list_folder_contents (and check region)."
                    : undefined,
        };
    }
    const parsed = parseStorageUrn(storageUrn);
    if (!parsed) {
        return { status: "error", error: `Unexpected storage URN shape: ${storageUrn}` };
    }
    const { bucketKey, objectKey } = parsed;
    // ── 2–4. Push bytes into the WIP storage object (OSS signed-S3 flow) ──────
    const PART_SIZE = 5 * 1024 * 1024;
    const numParts = Math.max(1, Math.ceil(fileSizeBytes / PART_SIZE));
    try {
        const signed = await getSignedS3UploadUrl(token, bucketKey, objectKey, 60, numParts, region);
        if (!signed.urls?.length)
            throw new DAError("OSS returned no upload URL.");
        for (let i = 0; i < numParts; i++) {
            const chunk = fileBuffer.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
            await uploadToS3(signed.urls[i], chunk, contentType);
        }
        await finalizeS3Upload(token, bucketKey, objectKey, signed.uploadKey, undefined, region);
    }
    catch (err) {
        const e = err;
        return {
            status: "error",
            error: `Uploading bytes to the storage slot failed: ${e.message}`,
            hint: e.statusCode === 403 && !region
                ? "If the hub is non-US, pass region (e.g. 'CAN') — the WIP bucket is on a regional shard."
                : undefined,
        };
    }
    // ── 5. Create the file item (or add a version if it already exists) ───────
    let itemId;
    let versionId;
    let createdNewVersion = false;
    try {
        const created = await createItem(projectId, folderId, fileName, storageUrn, token, region);
        itemId = created.itemId;
        versionId = created.versionId;
    }
    catch (err) {
        const e = err;
        const isConflict = e.statusCode === 409 || /already exists|conflict/i.test(e.message);
        if (!isConflict) {
            return {
                status: "error",
                error: `create_item failed: ${e.message}`,
                hint: "The bytes uploaded successfully but the item record wasn't created. Re-run is safe (a fresh storage slot is reserved each call).",
            };
        }
        // File exists in the folder.
        if (input.if_exists === "error") {
            return {
                status: "error",
                error: `A file named '${fileName}' already exists in this folder.`,
                hint: "Set if_exists:'new_version' (the default) to add a new version, or pass a different file_name.",
            };
        }
        // Add a new version to the existing file lineage.
        try {
            const existingItemId = await findItemByName(projectId, folderId, fileName, token, region);
            if (!existingItemId) {
                throw new DAError(`'${fileName}' reported as existing but no matching item was found in the folder.`);
            }
            versionId = await createVersion(projectId, existingItemId, fileName, storageUrn, token, region);
            itemId = existingItemId;
            createdNewVersion = true;
        }
        catch (verr) {
            const ve = verr;
            return {
                status: "error",
                error: `Adding a new version of '${fileName}' failed: ${ve.message}`,
                hint: "The bytes uploaded successfully. Adding the version on the existing file lineage failed — check write access.",
            };
        }
    }
    // ── Deep-link to the folder, and (best-effort) open it in the browser ─────
    const webUrl = accFolderUrl(region, projectId, folderId);
    let openedInBrowser = false;
    if (input.open_in_browser) {
        try {
            // macOS `open` (the MCP runs locally on the Mac, same as render_model).
            await execAsync(`open ${JSON.stringify(webUrl)}`);
            openedInBrowser = true;
        }
        catch {
            openedInBrowser = false; // non-fatal — the URL is still returned for manual open
        }
    }
    return {
        status: "success",
        item_id: itemId,
        version_id: versionId,
        storage_urn: storageUrn,
        file_name: fileName,
        folder_id: folderId,
        project_id: projectId,
        ...(hubId ? { hub_id: hubId } : {}),
        file_size_bytes: fileSizeBytes,
        ...(createdNewVersion ? { created_new_version: true } : {}),
        web_url: webUrl,
        project_files_url: accProjectUrl(region, projectId),
        opened_in_browser: openedInBrowser,
        ...(input.folder_path ? { folder_resolved_from_path: input.folder_path, folders_created: foldersCreated } : {}),
    };
}
// ── Source acquisition ──────────────────────────────────────────────────────
class SourceError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = "SourceError";
    }
}
async function acquireBytes(input, token) {
    if (input.source_oss_url) {
        const withoutScheme = input.source_oss_url.replace(/^oss:\/\//, "");
        const name = basename(withoutScheme);
        const buffer = await downloadOssObject(input.source_oss_url, token);
        return { buffer, name };
    }
    if (input.file_path) {
        const p = normalizePath(input.file_path);
        if (!existsSync(p)) {
            const isOneDrive = p.includes("/Library/CloudStorage/OneDrive");
            throw new SourceError(isOneDrive
                ? `File '${basename(p)}' is cloud-only in OneDrive — not downloaded to this Mac yet.`
                : `File not found: '${p}'`, isOneDrive ? "Click the file once in Finder to sync it locally, then retry." : undefined);
        }
        if (!statSync(p).isFile())
            throw new SourceError(`Path is not a file: '${p}'`);
        return { buffer: readFileSync(p), name: basename(p) };
    }
    // file_url
    const fileUrl = input.file_url;
    const res = await fetch(fileUrl);
    if (!res.ok)
        throw new SourceError(`Failed to fetch URL (HTTP ${res.status}): ${fileUrl}`);
    const name = decodeURIComponent(basename(new URL(fileUrl).pathname).split("?")[0]) || "upload";
    return { buffer: Buffer.from(await res.arrayBuffer()), name };
}
// Download an OSS object, choosing the right token identity.
//
// A source object from a Design Automation / Model Derivative job lives in the
// APP-owned (2LO) bucket. A 3LO USER token generally can't read it (AUTH-012 /
// 403) — so we download with a 2LO app token first, which owns the bucket, and
// fall back to the 3LO token only if 2LO isn't configured or the object happens
// to be user-scoped. This is what lets `source_oss_url` work in one call instead
// of forcing a local get_result download + re-publish.
//
// No region header: the source bucket's region is independent of the destination
// ACC hub's region (a US DA output published into a CAN hub is the common case).
async function downloadOssObject(ossUrl, threeLeggedToken) {
    const tokens = [];
    try {
        const twoLegged = await resolveCredential(["data:read", "bucket:read"]);
        tokens.push(twoLegged.access_token);
    }
    catch {
        // 2LO not configured — fall back to the 3LO token below.
    }
    tokens.push(threeLeggedToken);
    let lastErr;
    for (const tok of tokens) {
        try {
            const signedUrl = await getSignedS3DownloadUrl(tok, ossUrl);
            const res = await fetch(signedUrl);
            if (!res.ok) {
                lastErr = new Error(`download HTTP ${res.status}`);
                continue;
            }
            return Buffer.from(await res.arrayBuffer());
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw new SourceError(`Could not download the source object with app (2LO) or user (3LO) credentials: ${String(lastErr)}`, "If this is a Design Automation / Model Derivative output, it sits in an app-owned bucket — " +
        "ensure 2LO credentials are configured (authenticate_aps). The object may also have expired " +
        "(transient buckets last 24h) — re-run the job to regenerate it.");
}
// ── Data Management JSON:API calls ──────────────────────────────────────────
function dmHeaders(token, region) {
    const h = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
    };
    if (region)
        h["x-ads-region"] = region.toUpperCase();
    return h;
}
async function createStorage(projectId, folderId, fileName, token, region) {
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "objects",
            attributes: { name: fileName },
            relationships: {
                target: { data: { type: "folders", id: folderId } },
            },
        },
    };
    const res = await fetch(`${DM_BASE}/projects/${encodeURIComponent(projectId)}/storage`, {
        method: "POST",
        headers: dmHeaders(token, region),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    if (!json.data?.id)
        throw new DAError("create_storage response missing data.id");
    return json.data.id;
}
async function createItem(projectId, folderId, fileName, storageUrn, token, region) {
    // ACC/BIM360 use the autodesk.bim360 extension types for both items and versions.
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "items",
            attributes: {
                displayName: fileName,
                extension: { type: "items:autodesk.bim360:File", version: "1.0" },
            },
            relationships: {
                tip: { data: { type: "versions", id: "1" } },
                parent: { data: { type: "folders", id: folderId } },
            },
        },
        included: [
            {
                type: "versions",
                id: "1",
                attributes: {
                    name: fileName,
                    extension: { type: "versions:autodesk.bim360:File", version: "1.0" },
                },
                relationships: {
                    storage: { data: { type: "objects", id: storageUrn } },
                },
            },
        ],
    };
    const res = await fetch(`${DM_BASE}/projects/${encodeURIComponent(projectId)}/items`, {
        method: "POST",
        headers: dmHeaders(token, region),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    if (!json.data?.id)
        throw new DAError("create_item response missing data.id");
    const versionId = json.included?.find((i) => i.type === "versions")?.id;
    return { itemId: json.data.id, versionId };
}
// ── Folder path resolution (find-or-create) ─────────────────────────────────
class FolderResolveError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = "FolderResolveError";
    }
}
const PROJECT_BASE = "https://developer.api.autodesk.com/project/v1";
const DEFAULT_TOP_FOLDER = "Project Files";
// ACC folders carry the name in attributes.name; some surfaces use displayName.
function folderName(attrs) {
    if (!attrs)
        return "";
    return (attrs.name || attrs.displayName) ?? "";
}
async function listTopFolders(hubId, projectId, token, region) {
    const res = await fetch(`${PROJECT_BASE}/hubs/${encodeURIComponent(hubId)}/projects/${encodeURIComponent(projectId)}/topFolders`, { headers: dmHeaders(token, region) });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    return (json.data ?? [])
        .filter((d) => Boolean(d.id))
        .map((d) => ({ id: d.id, name: folderName(d.attributes) }));
}
// List only the SUBFOLDERS of a folder, following pagination defensively.
async function listSubfolders(projectId, folderId, token, region) {
    const out = [];
    let url = `${DM_BASE}/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents` +
        `?filter[type]=folders&page[limit]=200`;
    let guard = 0;
    while (url && guard++ < 25) {
        const res = await fetch(url, { headers: dmHeaders(token, region) });
        if (!res.ok)
            throw new DAError(await res.text(), res.status);
        const json = (await res.json());
        for (const d of json.data ?? []) {
            if (d.type === "folders" && d.id)
                out.push({ id: d.id, name: folderName(d.attributes) });
        }
        const next = json.links?.next;
        url = typeof next === "string" ? next : (next?.href ?? null);
    }
    return out;
}
async function createFolder(projectId, parentFolderId, name, token, region) {
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "folders",
            attributes: {
                name,
                extension: { type: "folders:autodesk.bim360:Folder", version: "1.0" },
            },
            relationships: {
                parent: { data: { type: "folders", id: parentFolderId } },
            },
        },
    };
    const res = await fetch(`${DM_BASE}/projects/${encodeURIComponent(projectId)}/folders`, {
        method: "POST",
        headers: dmHeaders(token, region),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    if (!json.data?.id)
        throw new DAError("create_folder response missing data.id");
    return json.data.id;
}
// Resolve a "Top Folder/sub/sub" path to a folder id, reusing existing folders
// and creating missing ones (when createMissing). Top folders are never created.
async function resolveFolderPath(projectId, hubId, rawPath, createMissing, token, region) {
    const segments = rawPath
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean);
    if (segments.length === 0)
        throw new FolderResolveError("folder_path is empty.");
    const topFolders = await listTopFolders(hubId, projectId, token, region);
    if (topFolders.length === 0) {
        throw new FolderResolveError("No top folders returned for this project.", "Check hub_id and project_id match this hub (and pass region for non-US hubs).");
    }
    // Root the path: first segment may name a top folder; otherwise default to
    // 'Project Files' and treat the whole path as a subfolder path beneath it.
    let rootId;
    let remaining;
    const topMatch = topFolders.find((f) => nameEq(f.name, segments[0]));
    if (topMatch) {
        rootId = topMatch.id;
        remaining = segments.slice(1);
    }
    else {
        const def = topFolders.find((f) => nameEq(f.name, DEFAULT_TOP_FOLDER));
        if (!def) {
            throw new FolderResolveError(`'${segments[0]}' is not a top folder, and the default top folder '${DEFAULT_TOP_FOLDER}' was not found.`, `Available top folders: ${topFolders.map((f) => f.name).join(", ")}. ` +
                "Prefix folder_path with one of these, or pass an exact folder_id.");
        }
        rootId = def.id;
        remaining = segments;
    }
    // Walk each remaining segment: reuse if present, create if missing.
    const created = [];
    let currentId = rootId;
    for (const seg of remaining) {
        const children = await listSubfolders(projectId, currentId, token, region);
        const matches = children.filter((c) => nameEq(c.name, seg));
        if (matches.length === 1) {
            currentId = matches[0].id; // reuse existing — never duplicate
        }
        else if (matches.length > 1) {
            throw new FolderResolveError(`Ambiguous: ${matches.length} folders named '${seg}' already exist at this level.`, `Matching folder ids: ${matches.map((m) => m.id).join(", ")}. Pass the exact one as folder_id.`);
        }
        else if (createMissing) {
            currentId = await createFolder(projectId, currentId, seg, token, region);
            created.push(seg);
        }
        else {
            throw new FolderResolveError(`Folder '${seg}' does not exist and create_missing is false.`, "Set create_missing: true to create it, or pass an existing folder_id.");
        }
    }
    return { folderId: currentId, created };
}
// ── Hub / project resolution (by id or name) ────────────────────────────────
class ResolveError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.hint = hint;
        this.name = "ResolveError";
    }
}
async function listHubs(token) {
    // No x-ads-region header: list_hubs returns empty/403 on a regional shard —
    // region is used to FILTER results (attributes.region), not to route the call.
    const res = await fetch(`${PROJECT_BASE}/hubs`, { headers: dmHeaders(token) });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    return (json.data ?? [])
        .filter((d) => Boolean(d.id))
        .map((d) => ({
        id: d.id,
        name: d.attributes?.name ?? "",
        region: String(d.attributes?.region ?? "").toUpperCase(),
    }));
}
async function listHubProjects(hubId, token) {
    const out = [];
    let url = `${PROJECT_BASE}/hubs/${encodeURIComponent(hubId)}/projects?page[limit]=200`;
    let guard = 0;
    while (url && guard++ < 25) {
        const res = await fetch(url, { headers: dmHeaders(token) });
        if (!res.ok)
            throw new DAError(await res.text(), res.status);
        const json = (await res.json());
        for (const d of json.data ?? []) {
            if (d.id)
                out.push({ id: d.id, name: d.attributes?.name ?? "" });
        }
        const next = json.links?.next;
        url = typeof next === "string" ? next : (next?.href ?? null);
    }
    return out;
}
// Resolve {hubId?, projectId} from any mix of project_id/project_name + hub hints.
// Fast path (project_id + hub_id) makes zero API calls.
async function resolveProject(q, token) {
    if (q.projectId && q.hubId)
        return { hubId: q.hubId, projectId: q.projectId };
    // Candidate hubs.
    let hubs;
    if (q.hubId) {
        hubs = [{ id: q.hubId, name: q.hubName ?? "", region: (q.region ?? "").toUpperCase() }];
    }
    else {
        hubs = await listHubs(token);
        if (q.hubName)
            hubs = hubs.filter((h) => nameEq(h.name, q.hubName));
        if (q.region)
            hubs = hubs.filter((h) => h.region === q.region.toUpperCase());
        if (hubs.length === 0) {
            throw new ResolveError("No hubs matched the given hub_name/region.", "Drop or correct hub_name/region, or pass hub_id directly.");
        }
    }
    // project_id known → find which candidate hub owns it (needed for folder_path).
    if (q.projectId) {
        const matches = [];
        for (const h of hubs) {
            const projects = await listHubProjects(h.id, token);
            if (projects.some((p) => p.id === q.projectId))
                matches.push({ hubId: h.id, projectId: q.projectId });
        }
        if (matches.length === 1)
            return matches[0];
        if (matches.length === 0)
            return { hubId: q.hubId, projectId: q.projectId }; // still usable for folder_id mode
        throw new ResolveError(`project_id ${q.projectId} matched in ${matches.length} hubs.`, `Pass hub_id to disambiguate. Hubs: ${matches.map((m) => m.hubId).join(", ")}.`);
    }
    // Resolve by project_name across candidate hubs.
    const named = [];
    for (const h of hubs) {
        const projects = await listHubProjects(h.id, token);
        for (const p of projects) {
            if (nameEq(p.name, q.projectName))
                named.push({ hubId: h.id, hubName: h.name, projectId: p.id });
        }
    }
    if (named.length === 1)
        return { hubId: named[0].hubId, projectId: named[0].projectId };
    if (named.length === 0) {
        throw new ResolveError(`No project named '${q.projectName}' found` +
            `${q.hubName ? ` in hub '${q.hubName}'` : ""}${q.region ? ` (region ${q.region})` : ""}.`, "Check the exact project name (case-sensitive), or pass project_id.");
    }
    throw new ResolveError(`${named.length} projects named '${q.projectName}' exist across hubs.`, `Narrow with hub_name or region. Candidates: ${named.map((m) => `${m.hubName || "?"}/${m.projectId}`).join(", ")}.`);
}
// ── Existing-file lookup + add-version ──────────────────────────────────────
// Find an existing item (file lineage) by display name in a folder; null if absent.
async function findItemByName(projectId, folderId, fileName, token, region) {
    let url = `${DM_BASE}/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/contents` +
        `?filter[type]=items&page[limit]=200`;
    let guard = 0;
    while (url && guard++ < 25) {
        const res = await fetch(url, { headers: dmHeaders(token, region) });
        if (!res.ok)
            throw new DAError(await res.text(), res.status);
        const json = (await res.json());
        for (const d of json.data ?? []) {
            if (d.type === "items" && d.id && nameEq(d.attributes?.displayName, fileName))
                return d.id;
        }
        const next = json.links?.next;
        url = typeof next === "string" ? next : (next?.href ?? null);
    }
    return null;
}
async function createVersion(projectId, itemId, fileName, storageUrn, token, region) {
    const body = {
        jsonapi: { version: "1.0" },
        data: {
            type: "versions",
            attributes: {
                name: fileName,
                extension: { type: "versions:autodesk.bim360:File", version: "1.0" },
            },
            relationships: {
                item: { data: { type: "items", id: itemId } },
                storage: { data: { type: "objects", id: storageUrn } },
            },
        },
    };
    const res = await fetch(`${DM_BASE}/projects/${encodeURIComponent(projectId)}/versions`, {
        method: "POST",
        headers: dmHeaders(token, region),
        body: JSON.stringify(body),
    });
    if (!res.ok)
        throw new DAError(await res.text(), res.status);
    const json = (await res.json());
    if (!json.data?.id)
        throw new DAError("create_version response missing data.id");
    return json.data.id;
}
