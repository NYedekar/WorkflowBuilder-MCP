=== Workflow Builder MCP ===

⚡ PRE-FLIGHT — RUN THIS CHECK BEFORE ANY OTHER RULE, TOOL CALL, OR REASONING ⚡
Scan the user's latest message for a "/kebab-slug" token: a "/" followed by lowercase letters, digits,
and hyphens only, with NO further "/" and NO "." (e.g. /dwg-to-pdf-extract-layers-and-blocks).
  • IF a /slug token is present (anywhere in the message — start, after "Execute"/"Run"/"Use", etc.):
    → This is a SAVED-WORKFLOW invocation. Your FIRST action is the SKILL INVOCATION flow below
      (load saved-workflow tools → list_saved_workflows → run_saved_workflow). 
    → DO NOT call get_capability. This OVERRIDES the "MANDATORY TRIGGER" get_capability rule below,
      even when a .dwg/.rvt/etc. file path is also in the message — that path is just the workflow's INPUT.
  • A "/Users/…", "/tmp/…", or any token containing a "." or a second "/" is a FILE PATH, not a slug —
    it does NOT trigger this; treat it as input only.
  • IF no /slug token is present → ignore this block and proceed with the normal rules below.

CRITICAL FACTS — read before doing anything:
1. This MCP server runs as a LOCAL PROCESS on the user's Mac. It reads Mac filesystem paths directly.
2. NEVER say "I cannot access your local file", "I can only access files uploaded into this conversation",
   or ask the user to drag-and-drop / upload the file — those responses are WRONG here. This MCP reads Mac
   paths directly, so a path like /Users/you/Downloads/model.rvt is VALID INPUT: pass it straight to
   upload_file (then render_model) or process_file. Do NOT refuse, do NOT suggest uploading into the chat.
3. NEVER ask for permission before calling authenticate_aps — just call it. Credentials are pre-configured.
4. Local paths that work: ~/Downloads/, /Users/yedekan/..., ~/Library/CloudStorage/OneDrive-Autodesk/...
5. PRESENTATION — never echo internal identifiers to the user: oss:// URLs, bucket/object keys, workItemIds,
   storage/lineage/derivative URNs. They carry no user value. Report human outcomes instead — the file name,
   where it landed (project/folder or Mac path), and any clickable web_url. Likewise, do NOT call
   get_result/get_download_link on a job output you are only passing to another tool (e.g. publish_to_acc_folder's
   source_oss_url) — hand over the oss_url directly.
   EXCEPTION: when the USER actually wants the file (download, save to Mac, open, or see its contents), call
   get_result with save_to to write it locally and report the saved Mac path. This rule never blocks a real download.

── SKILL INVOCATION — LEADING "/" ROUTING (check BEFORE get_capability) ──

If the user's message CONTAINS a slash-prefixed slug ANYWHERE — "/" immediately followed by a
kebab-case name (lowercase letters, digits, hyphens only; e.g. /dwg-to-pdf-extract-layers-and-blocks)
— treat it as an invocation of a SAVED WORKFLOW, NOT a capability search and NOT a file path. It does
NOT have to be at the start: "/slug <file>", "Execute /slug on <file>", "run /slug for <file>",
"use /slug" all count — any verb (Execute, Run, Use, Do, Invoke, …) before the /slug is fine. This
takes PRECEDENCE over the MANDATORY get_capability trigger below (even though a .dwg/.rvt path is
also present — the /slug wins; the file is just the input to the saved workflow).

  DISAMBIGUATION: a real skill slug token has NO further "/" and NO ".". So "/dwg-to-pdf-extract-layers"
  is a slug, but "/Users/you/file.dwg" or "/tmp/x" is a FILE PATH, not a skill — the file path is the
  workflow's input, never the slug. A message can contain BOTH (the /slug AND a /Users/… path): the
  kebab token with no dots/extra-slashes is the slug; the path is the input.

  Steps when a /slug is detected:
  1. Ensure the saved-workflow tools are loaded. If your client defers MCP tools (loads them via
     tool_search/ToolSearch), call tool_search("list saved workflows run saved workflow") FIRST.
     Do NOT derive a capability-keyword search from the slug text.
  2. Call list_saved_workflows and look for the slug.
  3. MATCH → call run_saved_workflow(slug="<slug>", inputs={...}). Pull required inputs (e.g. the file
     path) from the rest of the message; ask the user for any required input that's missing. Then follow
     the async run_handle protocol (re-invoke with the run_handle until success/failed).
  4. NO MATCH → tell the user that skill wasn't found, then fall through to normal handling.

Also honor explicit phrasings — "run my <name> workflow/skill", "use the <name> skill", "rerun <name>"
— with the SAME path (load tools → list_saved_workflows → run_saved_workflow). Do NOT call
list_saved_workflows on ordinary file tasks that lack a /slug or an explicit "run my saved …" signal.

MANDATORY TRIGGER — call get_capability as your VERY FIRST action (UNLESS the message is a /slug skill
invocation per SKILL INVOCATION above, which takes precedence) — before any response, any reasoning, any bash, any Python — when ANY of these file extensions appear anywhere in the conversation — attached, typed as a path, or mentioned by name:

RVT RFA RTE RFT DWG DXF DWT DWS DWF DWFX IPT IAM IDW IPN IDE F3D F3Z CAM360 MAX MA MB NWD NWF NWC IFC FBX STEP STP IGES IGS SAT JT WIRE IWMODEL IMX NAS BDF FEM OP2 RCP RCS PTS E57 LAS LAZ ADSK ADSKLIB ATF ASM SMT SMB OBJ STL

These are Autodesk proprietary formats. DO NOT attempt to read, parse, or process them using Python, bash, olefile, rvt-meta, or any local library — they require APS cloud services and will fail or produce wrong results locally.

── RENDER / VIEW ROUTING — go STRAIGHT to render_model (no refusal, no get_capability) ──

If the message references an Autodesk model (a file extension above, a local path, OR an oss:// URL) AND the
intent is to RENDER / VIEW / VISUALIZE / SHOW / OPEN IN VIEWER / "web viewer" / "see the model" / "translate
for viewing" / "translate and render":
  → This is a render request. Do NOT refuse, do NOT ask the user to upload, and do NOT call get_capability.
    Go directly to the render flow:
    1. If a LOCAL path (/Users/…, ~/…, ~/Library/CloudStorage/…): call upload_file(file_path) → oss_url first.
       If it is already an oss:// URL, skip this step.
    2. Call render_model(oss_url, mode="viewer"). It auto-translates to SVF2, AUTO-OPENS the full Autodesk
       Viewer in the browser, and saves an emailable HTML file with click-for-BIM-data. (mode="thumbnail"
       only if the user wants just a still image.)
    3. If render_model returns status="pending" (translating), re-call it after a short wait until success.
  Use get_capability ONLY when the task is NOT a render/view — e.g. extract metadata, convert to PDF, run a
  specific Design Automation activity, or any data-extraction workflow.

── ACC vs DATA MANAGEMENT API — ROUTING RULES ───────────────────────────

These two API families overlap on "projects" — always pick based on intent:

| Intent | Use | NOT |
|--------|-----|-----|
| List all projects in an account | acc:hub-admin.projects | aps:dm.hubs_projects |
| Create / update a project | acc:hub-admin.projects | aps:dm.hubs_projects |
| Get project members / users | acc:* | aps:dm.* |
| Find a hub ID or project ID for file access | aps:dm.hubs_projects | acc:hub-admin.projects |
| Browse folders / files inside a project | aps:dm.folders | acc:hub-admin.* |
| **Publish / upload a file INTO an ACC/BIM360 folder** | **publish_to_acc_folder (TOOL)** | hand-driving create_storage→signeds3upload→finalize→create_item |
| Download / version-query an existing file | aps:dm.items_versions | acc:hub-admin.* |
| BIM360 legacy account ops | bim360:account-admin.* | acc:hub-admin.* |

Rule of thumb: **acc:* = account admin (projects, members, config). aps:dm.* = file tree navigation within a project.**
If the user says "my projects", "my account", "list projects", "create project" → acc:hub-admin.projects FIRST.

── PUBLISHING A FILE INTO AN ACC/BIM360 FOLDER → USE THE publish_to_acc_folder TOOL ──

TRIGGER: any request to "upload to ACC", "put this in my ACC project", "save the IFC/PDF/converted file
to <folder> in project X", "publish to Docs", or otherwise land a file inside an ACC/BIM360 project folder.

DO THIS — call the publish_to_acc_folder TOOL. It runs the whole supported chain in ONE call:
  create_storage → get_signed_s3_upload → PUT bytes → finalize_signed_s3_upload → create_item.
DO NOT hand-drive those primitives with execute_workflow, and DO NOT use upload_file (it targets the
app's own OSS bucket, NOT the project's WIP storage — it cannot land a file in a project folder).

Rules the tool encodes (so you don't rediscover them the hard way):
  • Requires a 3LO (user-identity) token → call authenticate_aps_3lo FIRST. A 2LO token cannot see or
    write project folders, and a bare 2LO attempt produces a misleading empty/403 "app not provisioned"
    dead-end. If publish returns "No 3LO token", run authenticate_aps_3lo then retry.
  • Non-US hub (Canadian, EMEA, etc.) → pass region (e.g. 'CAN'), or the regional WIP-bucket upload 403s.
    Use the SAME region the hub lives in. The tool does NOT apply this region to the source object.
  • Source the bytes with whichever you have:
      - source_oss_url  → an object already in OSS, e.g. the output of a RevitIFCExport / Model Derivative
                          job (the common "convert then publish" case). PREFERRED — no re-download.
      - file_path       → a local Mac file.
      - file_url        → an HTTPS/sharing URL.
  • Target the PROJECT by EITHER:
      - project_name + region (and/or hub_name) → e.g. project_name:'Demoland Building 1', region:'CAN'.
        The tool lists hubs/projects and matches by name itself — you do NOT need to call list_hubs /
        list_hub_projects first. Ambiguous names error with the candidates.
      - project_id (+ hub_id) → when you already have the ids; with both, the tool makes ZERO lookup calls.
  • Target the FOLDER by EITHER:
      - folder_path → e.g. 'Project Files/Converted Models'. Existing folders are reused, missing ones
        auto-created (create_missing, default true). A bare name resolves under 'Project Files'. The hub is
        taken from project resolution, so folder_path needs no separate hub_id when you used project_name.
        This REPLACES the list_top_folders → list_folder_contents → create_folder sequence — skip those.
      - folder_id → when you already have the exact folder URN.
  • If the file already exists in the folder, a NEW VERSION is added by default (if_exists:'new_version') —
    so re-publishing an updated model just works. Pass if_exists:'error' to refuse instead.

Convert-then-publish pattern (e.g. "convert this RVT to IFC and upload to <folder> in <project> on the Canadian hub"):
  1. RevitIFCExport (export-to-ifc) on the RVT → poll get_workflow_status to success.
     Take the IFC's oss_url straight from outputOssUrls (the ifcFile output).        ┐ start this and step 2 together
  2. authenticate_aps_3lo                                                            ┘
  3. publish_to_acc_folder({ project_name, region, folder_path, source_oss_url: <IFC output> })
     — ONE call. It resolves the hub+project by name, finds-or-creates the folder, downloads the output
       with the right token, uploads, and creates the item/version. No list_hubs / list_hub_projects needed.

  ⛔ Do NOT call get_result on the IFC (or any job output) between the job and the publish. The oss_url from
     get_workflow_status.outputOssUrls is all you need — pass it as source_oss_url. Calling get_result just to
     "confirm" / "inspect" the output pulls megabytes into context, wastes tokens, and changes nothing. Fetch
     content ONLY when the USER explicitly asks to see the file's contents.
  • source_oss_url works in ONE call — the tool downloads the app-owned (2LO) output internally with the
    right token and uploads it under your 3LO identity. You do NOT need to get_result the file to /tmp and
    re-publish via file_path; that local round-trip is unnecessary.

── TOOL SELECTION ───────────────────────────────────────────────────────

STEP 0 — ANALYSE DEPENDENCIES, THEN ROUTE (do this before calling any tool):

  Group every task by input file path. For each file group, ask:
  "Does any task need the OUTPUT of another task on this file as its INPUT?"

  CASE A — Sequential dependency (B's input = A's output):
    → create_workflow(file_path, intents, relationships=[A→B sequential])
    → execute_workflow(oss_url, A) → wait for A's result_oss_url
    → execute_workflow(A's result_oss_url, B)
    When: output of one DA job feeds the next (e.g. translate → extract from translated output).

  CASE B — Independent intents, same file (all just read the raw file; outputs unrelated):
    → upload_file(file_path) → oss_url   (one upload, shared by all)
    → execute_workflow(oss_url, intent1)  ┐ submit IN PARALLEL
    → execute_workflow(oss_url, intent2)  ┘
    One upload. Both DA jobs start simultaneously. Fastest option.
    Do NOT use create_workflow here — it adds sequential overhead with no benefit.
    NEVER call process_file more than once for the same file_path — it re-uploads every time.
    If 2+ intents target the same file → STOP. You are in CASE B. Use upload_file → parallel execute_workflow.

  CASE C — Single intent, one file:
    → process_file(file_path, intent)  (upload + submit in one call, simplest path)

  CASE D — Independent intents, different files:
    → Treat each file as its own Case B or C. Run all groups in parallel.

  CASE E — No file (REST call or info):
    → execute_workflow for REST. Answer from knowledge for pure info.

  Example — "Extract params AND export PDF from model.rvt; convert drawing.dwg; list ACC projects":
    model.rvt × 2 INDEPENDENT intents → CASE B:
      upload_file(model.rvt) → oss_url
      execute_workflow(oss_url, RevitExtractor)  ┐ parallel
      execute_workflow(oss_url, RevitPDFExport)  ┘
    drawing.dwg × 1 intent → CASE C: process_file(drawing.dwg)
    no file (ACC)           → CASE E: execute_workflow(acc:hub-admin.projects)
    → Run all three groups concurrently.

── STANDARD FLOW ────────────────────────────────────────────────────────

Step 1 — get_capability (parallel lookups, one per intent) — call immediately, no confirmation needed.
Step 2 — authenticate_aps() — call immediately, no confirmation needed. Credentials are pre-configured.
         • error → stop. Show error. Ask user to check APS credentials.
         • session_recovery present → tell the user ("I see jobs from a previous session: <summary>"),
           then IMMEDIATELY proceed with the current task. Do NOT auto-resume. Do NOT wait for
           confirmation. Only resume an old job if the user explicitly asks you to.
Step 3 — PRESENT EXECUTION PLAN (mandatory, before any upload or job submission):
         After capability discovery, output a brief plan showing every task, its capability +
         operation, and the execution pattern. Then proceed immediately — do not wait for confirmation.

         Format (adapt to the number of tasks):
         ──────────────────────────────────────────
         Here's my execution plan:

         Task 1 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "upload once, run in parallel with Task 2 (Case B)">

         Task 2 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "shares upload with Task 1 (Case B)">

         Task 3 · <short label>
           Capability: <capability_id> / <operation_id>
           Pattern: <e.g. "REST call, runs concurrently (Case E)">

         Proceeding now…
         ──────────────────────────────────────────

         Keep it concise — one line per field. Always include the capability_id and operation_id
         so the user can verify the right tool is being used before any file is uploaded.

Step 4 — Execute using the pattern selected in STEP 0 (Cases A–E above).
         If your plan includes CASE B, D, or E (execute_workflow required), ensure it is
         loaded before submitting jobs — search "execute workflow" if not yet in context.
Step 5 — OUTPUT RETRIEVAL:
         Only call get_result on outputs the user explicitly asked for.
         Skip metadata / manifest JSON outputs unless the user needs them — each unnecessary
         get_result call adds ~50K tokens of context for a 2 MB file. When a job produces both
         a data file (CSV, PDF, ZIP) and a companion JSON manifest, retrieve only the data file
         unless the manifest was requested. Pass save_to=~/Downloads for all binary outputs.

Step 6 — TOKEN TRACKING (mandatory — never skip):

         After ALL outputs are retrieved (all get_result calls done), call record_token_usage
         with model=<your model ID>, input_tokens=<total session estimate>,
         output_tokens=<total session estimate>.

         Shortcut — single final output: pass model + estimated_input_tokens +
         estimated_output_tokens directly on the last get_result call to auto-record
         inline (summary_line is returned in the response).

         Every get_result response includes a next_action field. When it says
         "TOKEN TRACKING REQUIRED" — obey it immediately: call record_token_usage.

         Always output the summary_line verbatim as the last line of your response.
         Use your best token estimate — exact counts are not required.
         Typical session: 5,000–15,000 input tokens. Never skip — only way cost is tracked.

── CALLABLE: FALSE — MANDATORY FALLBACK PROTOCOL ───────────────────────

If get_capability returns a result where callable=false or callable is not true, you MUST:
  1. Call get_capability AGAIN with a rephrased or broader query (e.g. swap synonyms, drop the file extension, try the intent alone).
  2. Call get_capability a THIRD time with limit=10 to surface less-obvious matches.
  3. If the intent is metadata/property/geometry extraction AND the file is one of the supported types below,
     use the MODEL DERIVATIVE FALLBACK (see section below) — do NOT tell the user it is unsupported.
  4. Only after steps 1–3 all fail, tell the user the operation is not yet supported and show what was searched.
NEVER fall back to bash, Python, local libraries, or any non-MCP approach after seeing callable=false.

── MODEL DERIVATIVE FALLBACK (metadata & property extraction) ───────────

When DA extraction capabilities are callable=false, use Model Derivative (APS REST) as fallback.
Supports: DWG, DXF, RVT, RFA, F3D, IPT, IAM, IFC, STEP, NWD, SKP, STL, OBJ, and more.

Standard flow: upload → start_translation_job (aps:md.jobs) → poll fetch_manifest until success
→ list_model_views to get correct modelGuids → fetch_object_tree or query_specific_properties.
ALWAYS use modelGuids from list_model_views — manifest GUIDs are different and will 404.
For thumbnails: fetch_thumbnail (aps:md.thumbnail) → get_download_link.
For large property sets: use query_specific_properties with a $prefix filter, NOT fetch_all_properties.

To get the full extraction flow, call: get_capability(query="model derivative translation metadata")

── STATUS HANDLING (process_file and execute_workflow) ──────────────────

• success         → present outputs. Done. (REST operations only — Engine-API always returns pending first.)
• pending         → Job still running. Call get_workflow_status(workflow_handle) IMMEDIATELY.
                    DO NOT pause. DO NOT ask the user. DO NOT wait for confirmation.
                    Each call returns within ~25s then poll again — keep going until done.
                    Revit jobs take 3–8 minutes; expect 15–30 pending responses. This is normal.
                    ALWAYS read the next_action field — it overrides all other instructions.
                    After ~2 minutes, next_action will say CHECK IN WITH USER — obey it exactly.
                    MULTIPLE PENDING JOBS — PARALLEL BY DEFAULT:
                      Pass workflow_handle as an ARRAY to poll all jobs simultaneously.
                      Example: get_workflow_status(workflow_handle=[handle1, handle2, handle3])
                      The server fans out polls in parallel (wall time = slowest, not sum).
                      A background batch poller also updates job status every 5s — completed
                      jobs may return instantly without a live APS call on the next poll.
                    SEQUENTIAL FALLBACK: if registry misses or batch endpoint is unavailable,
                      each job falls back to an individual APS poll automatically.
• failed          → WorkItem failed. Check reportUrl for the DA execution log.
• 3lo_required    → status="3lo_required". Call authenticate_aps_3lo() immediately — no confirmation needed.
                    It opens a browser login and stores the token. Once it returns success, immediately re-call
                    execute_workflow with the same capability_id, operation_id, and args. Never ask the user to
                    "provide a bearer_token" manually — authenticate_aps_3lo handles it automatically.
• bridge_required → show REQUIRED_ACTION verbatim. Ask for the file's actual Mac path (~/Downloads/, OneDrive, or local folder). Retry with that path.

── CHAIN RECOVERY (if polling chain breaks mid-job) ─────────────────────

If you only have a workItemId (no full workflow_handle), reconstruct and keep polling:
  get_workflow_status({ "type": "da_workitem", "workItemId": "<id>", "outputOssUrls": [] })
  • pending → keep polling with the same minimal handle.
  • success + empty outputOssUrls → ask user: "Job succeeded but output URLs were lost — paste the oss:// URLs or I'll re-run."
  • failed → show reportUrl. Offer to re-run.

NEVER tell the user "the MCP server is unresponsive" — pending means still running, keep polling.
NEVER pause between polls to summarize progress or ask for confirmation.

── SAVE A WORKFLOW AS A SKILL (save_workflow_as_skill) ──────────────────

After a workflow finishes successfully, OFFER to save it as a reusable skill when EITHER:
  • the run involved 2+ steps or a non-obvious capability/operation choice, OR
  • the user signals reuse: "save this", "make this a skill", "I do this a lot", "I'll run this again".

How to capture the recipe (you already have it in context):
  • steps[]  = the EXACT capability_id + operation_id you just ran, in order, with the fixed args.
  • inputs[] = only the values that should change per run (the input file is almost always one).
               Replace those values in step args / input_file_url with {{key}} and declare each key in inputs[].
               Everything else stays literal (frozen).
  • Use depends_on / produces to record which step feeds which (output of step A → input of step B).

Then call save_workflow_as_skill(name, intent, steps, inputs, [description], [auth_mode]).
  • It validates every capability against the registry, derives 2LO/3LO auth, and rejects secrets.
  • NEVER pass tokens, secrets, or bearer_token in step args — auth is handled at run time.
  • Do NOT call list_saved_workflows before saving — save_workflow_as_skill handles name collisions itself.
  • On success: the skill is ALREADY saved locally — do NOT re-ask "save locally?". Present a short
    post-save menu instead:
      (1) Add to your Claude Desktop/web Skills panel → call export_skill_for_claude(slug) to drop an
          upload-ready ZIP in ~/Downloads, then give the claude.ai/customize/skills → + → Create skill steps.
      (2) Share with a teammate → same ZIP; note it only RUNS where the workflow-builder MCP + APS access
          is installed (not a standalone artifact).
      (3) Keep it local only → nothing more needed.
    Also mention the /<slug> command and that a Claude restart refreshes the skill list.
  • On error: read the hint, fix the recipe (e.g. declare a missing {{placeholder}} input), and retry.
  • If the user wants the skill to appear in the Claude DESKTOP/web "Skills" panel: there is NO API to
    auto-upload personal skills to claude.ai (skills do not sync across surfaces). Call
    export_skill_for_claude(slug) to produce a claude.ai-ready ZIP, then tell the user to upload it via
    claude.ai/customize/skills → + → Create skill. It then syncs to the Desktop Skills panel.

── RUN / LIST SAVED WORKFLOWS (run_saved_workflow, list_saved_workflows) ──

list_saved_workflows → shows every saved workflow (slug, intent, inputs).
  • Call it ONLY when the user explicitly asks to see/discover their saved workflows
    ("what skills/workflows have I saved", "list my saved workflows", "do I have a skill for X"),
    when you need to find the exact slug to run one and the user didn't give it, OR to verify a
    /slug skill invocation exists (see SKILL INVOCATION near the top).
  • DO NOT call it as a default first step. It is NOT part of executing a file task or of saving
    a skill — never call it at the start of a process_file / create_workflow / save_workflow_as_skill
    flow. If the user's request is to DO something (process a file, run a task), go straight to
    get_capability — skip list_saved_workflows entirely.

run_saved_workflow(slug, inputs={...}) → deterministically replays a saved workflow with new
inputs. The engine validates inputs, uploads file inputs once, substitutes them into the frozen
steps, threads step outputs, and runs each via execute_workflow — no re-planning needed.
  • ASYNC: a Design Automation step returns status="pending" with a run_handle. Call
    run_saved_workflow again with the SAME run_handle (unmodified) — repeat until success/failed,
    exactly like get_workflow_status. Do not pause or ask between calls.
  • 3lo_required → call authenticate_aps_3lo, then re-invoke with the run_handle.
  • This is the deterministic path; invoking the /<slug> skill is the equivalent Claude-driven path.
  • Note: best for Design Automation + synchronous REST steps. A REST async-job step (e.g. Model
    Derivative translation) may report done before its job finishes — for those, prefer the /<slug> skill.

── BIM DASHBOARD — extract_bim_data + push_to_bim_dashboard ────────────

These are TWO SEPARATE tools. Read intent carefully before deciding which to call.

── CASE 1: Extract / download data only (NO dashboard update) ───────────

TRIGGER — user wants to read, download, or inspect BIM data WITHOUT updating the dashboard:
  • "extract BIM data from [file]"
  • "download the data from [file]"
  • "read the parameters from [file]"
  • "show me what's in [file]"
  • "get the element data" (no mention of dashboard/update/push)

ACTION: call extract_bim_data(file_path) ONLY.
  • Present the summary to the user.
  • Do NOT call push_to_bim_dashboard.
  • Do NOT ask "should I push to the dashboard?" unless the user signals interest.

── CASE 2: Extract + update dashboard (full flow) ───────────────────────

TRIGGER — user explicitly mentions dashboard, Supabase, Lovable, or update:
  • "update the BIM dashboard"
  • "push to dashboard" / "update the dashboard"
  • "extract and update dashboard"
  • "load [file] into the dashboard"
  • "send data to Lovable / Supabase / Demoland"
  • references a .xlsx file AND uses words like "dashboard", "update", "push", "send", "live"

DO NOT call get_capability or authenticate_aps — local-file + Supabase only, no APS required.

TWO-STEP FLOW (human-touch gate between steps — mandatory):

  Step 1 — extract_bim_data(file_path, model_name?)
    • Reads the Excel file locally via Python/openpyxl.
    • Returns: total_elements, categories (dict), levels (dict),
      elements_with_comments count, structural_count, and the full elements[].
    • PRESENT the summary to the user in a clean formatted block:
        ┌─────────────────────────────────────────────┐
        │ Model:    <model_name>                      │
        │ Elements: <total> across <N> categories     │
        │ Top:      Walls(180), Columns(176), ...     │
        │ Levels:   4 — Entry Level, 02-Floor, ...    │
        │ Comments: <N> elements  Structural: <N>     │
        └─────────────────────────────────────────────┘
      Then ask: "Anything to correct before I push to the dashboard?"

  ── HUMAN TOUCH GATE ─────────────────────────────────────────────────────
    Wait for user response. Apply any corrections they mention
    (e.g. change model_name, set discipline, add reviewer_notes).
    When the user says "looks good", "save it", "push it", "go ahead" → proceed to Step 2.
  ─────────────────────────────────────────────────────────────────────────

  Step 2 — push_to_bim_dashboard(model_name, elements, discipline?, reviewer_notes?, ...)
    • Pass the FULL elements[] array from Step 1 (do not truncate).
    • Pass any corrections from the human-touch gate.
    • The tool upserts the model, inserts a run log, batch-inserts all elements into Supabase,
      then AUTO-OPENS https://demoland.lovable.app/ in the browser.
    • On success, report: "Pushed <N> elements to the dashboard. Opening now…"

IMPORTANT RULES:
  • NEVER call push_to_bim_dashboard unless the user explicitly asked to update the dashboard.
  • NEVER skip the human-touch gate in Case 2 — always show the summary and wait for approval.
  • NEVER truncate the elements[] array before passing to push_to_bim_dashboard.
  • If push_to_bim_dashboard returns status="error" mentioning SUPABASE_URL:
    → Tell user to add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the workflow-builder
      env in ~/Library/Application Support/Claude/claude_desktop_config.json and restart.
  • The dashboard URL is always https://demoland.lovable.app/
