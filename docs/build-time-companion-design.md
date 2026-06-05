# Build‑Time Companion — Design Doc (v2)

**Let any developer build and deploy a real APS web app *without first having to learn APS* — by connecting the Workflow‑Builder MCP to their AI coding agent (Claude Code / Cursor / GitHub Copilot).**

| | |
|---|---|
| **Status** | Design — no implementation yet. Eng commitment gated on the Phase‑0 A/B experiment (§9). |
| **Author** | Neeraj Yedekar (with Claude, acting as AI engineer / architect) |
| **Date** | 2026‑06‑04 |
| **Version** | v2 — rewritten after `/deepthink` architect+premortem pressure-test |
| **Project** | mcp-workflow-builder (v1 complete; this is a new build‑time mode, additive to the runtime engine) |
| **Locked decisions** | Stack = **Next.js + TypeScript** · Deploy = **GitHub → Vercel** · Scope = **phased, demo‑first (AU 2026)** · Primary client = **Claude Code first** (Cursor second, Copilot best‑effort) |
| **Related** | `docs/in-panel-3d-handoff.md` (web build / Streamable‑HTTP) · v2 "Code Mode" meta‑tool concept · `/appbuilder` skill (encode-the-rules philosophy) · AU 2026 demo plan · MCP app‑types registry · APS‑for‑small‑business / APS Tools strategy |

---

## 1. TL;DR

APS is powerful but has a steep expertise wall: to build even a simple app a developer must know *which* services to combine, *which* auth flow to pick, *which* scopes, and a pile of non‑obvious gotchas (async polling, refresh‑token rotation, Viewer tokens). **This project removes that prerequisite.**

A developer connects the Workflow‑Builder MCP to their AI coding agent and, from a plain‑language prompt, the agent — **using our MCP as its APS brain** — builds, verifies, and deploys a working APS web app (Next.js → GitHub → Vercel). The agent writes the React/Node. **Our MCP supplies the APS *judgment and correctness* the developer would otherwise need years to acquire.**

This is **additive** to the current MCP. The existing runtime engine (`workflow-runner`, `execute_workflow`, the 1,589‑operation registry, the auth stack, the Viewer assets) is reused — repurposed as the **verification oracle** and the **templates** the generated app embeds.

> **The strategic frame:** this is an **APS developer‑activation / funnel play** — more developers shipping on APS without an expertise barrier — not just a dev convenience tool. Its success metric is therefore *time‑to‑first‑working‑app for an APS‑naive developer*, not "agent accuracy."

---

## 2. The core insight — three layers of "APS knowledge"

The aim ("build APS apps without the entire knowledge of APS") only makes sense once you separate what "APS knowledge" actually is. It is **three layers with very different value**:

| Layer | What it is | Who can already supply it | Our position |
|---|---|---|---|
| **L1 — Syntax** | endpoint shapes, params, request/response JSON | docs / SDK / `llms.txt` | **Commodity.** Generate it for free; don't over‑invest or over‑claim. Evidence: in‑context docs give only a modest lift and can even *hurt* on common APIs. |
| **L2 — Architecture judgment** | *"to view a model you need OSS upload → Model Derivative SVF2 → Viewer with `viewables:read`, and 3LO/PKCE because it's the user's own file"* — capability selection + auth‑model decision + registration steps | **almost nobody without APS expertise** | **Moat #1 — and the real target of this project.** This is authored judgment, not a doc. |
| **L3 — Execution correctness** | does the assembled thing actually *run* against live APS | a build‑time verification loop | **Moat #2.** Evidence: execution feedback beats static context and is "universally effective" for code‑gen correctness. |

**Design consequence:** the product is **L2 + L3 as twin flagships**, with **L1 as generated plumbing**. Anything that's really just L1 (serving contracts/snippets) is supporting cast — keep it thin; `llms.txt`/SDK could do most of it.

*(Evidence basis: deepthink fan‑out, 2026‑06‑04 — CloudAPIBench arXiv:2407.09726; RLEF arXiv:2410.02089; Self‑Debug arXiv:2304.05128. No public benchmark directly A/Bs "MCP tool vs docs/SDK" on one API — hence the Phase‑0 experiment in §9.)*

---

## 3. Honest scope — what we remove, and the floor we can't

Removing "the entire knowledge of APS" is real but bounded. Be precise so we don't oversell:

- **We remove:** which services to use (L2), which auth flow + scopes (L2), the registration steps (L2 checklist), and the correctness audit a non‑expert can't perform themselves (L3).
- **Irreducible floor we cannot remove:** the developer must still create an APS app, obtain a client ID, set a callback URL, and authorize scopes. We *guide* this; we can't eliminate it.
- **Runtime gap:** build‑time verification gets them to a working app. *Operational* failures later (a user's RVT won't translate, a webhook misfires) still need some APS literacy. **Scope the promise to "build," not "operate forever unaided."**

---

## 4. The reframe: runtime engine → build‑time companion

Today the MCP is a **runtime engine**: a human composes a workflow DAG and the MCP executes it against APS. The new mode is a **build‑time companion**: the MCP supplies judgment and verifies while a coding agent authors a codebase. Nothing is thrown away — the runtime tools are repurposed:

| Today (runtime engine) | New role (build‑time companion) | Layer | Source files reused |
|---|---|---|---|
| `get_capability` / registry | Capability‑selection judgment + thin contract lookup | L2 + L1 | `registry-client.ts`, `capability-registry.json` |
| `execute_workflow` / `workflow-runner.ts` | **Verification oracle** — dry‑run a real APS call so the agent confirms a contract before wiring it in | **L3** | `workflow-runner.ts`, `execute-workflow.ts` |
| `auth/*` (2LO/3LO/PKCE) | **Auth‑recipe generator** (the decision *and* the hard refresh code) + the code the app embeds | **L2 + L3** | `auth/credential-resolver.ts`, `authenticate-aps-3lo.ts` |
| `render-model.ts` Viewer HTML | Viewer component template | L1 | `render-model.ts`, viewer HTML generators |
| save‑as‑skill re‑validation guard | **Static validator** that catches hallucinated/wrong calls in generated code | L3 | `save-workflow-as-skill.ts` validation path |

---

## 5. Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Developer's AI coding agent  (Claude Code first; Cursor; Copilot) │
│  - writes Next.js + TS, runs shell, git, vercel                    │
└───────────────▲───────────────────────────────────────────────────┘
                │  MCP over stdio (local, primary)  /  Streamable-HTTP (remote, later)
                │  ── server WRITES files to disk, returns a compact manifest ──
                │     (confirmed-correct pattern: Claude Code auto-persists
                │      large tool results to disk; "full file trees" is the
                │      documented use case. Do NOT push trees through results.)
┌───────────────┴───────────────────────────────────────────────────┐
│  Workflow-Builder MCP — BUILD-TIME COMPANION (new, additive)        │
│                                                                     │
│  ★ L2  PLAN     aps_plan_app          (capability + auth judgment)  │
│  ★ L2  AUTH     aps_auth_recipe       (flow choice + refresh code)  │
│  ★ L3  VERIFY   aps_dry_run · aps_validate_code · aps_smoke_test    │
│    L1  SCAFFOLD aps_scaffold · aps_get_snippet · aps_generate_client│
│    L1  DISCOVER aps_get_contract      (thin; or just llms.txt)      │
│        DEPLOY   aps_emit_deploy       (human-gated)                 │
│                                                                     │
│  ── reuses ──────────────────────────────────────────────────────  │
│  Registry (1,589 ops) · workflow-runner (oracle) · auth stack       │
│  · Viewer HTML templates · rate-limiter · session-store             │
└───────────────┬───────────────────────────────────────────────────┘
                │  live APS calls during dry_run / smoke_test
                │  (SCOPED, sandbox, non-destructive credential only)
                ▼
        Autodesk Platform Services (Model Derivative, OSS, Viewer, DA, …)

★ = flagship (the differentiated value). Everything else is plumbing.
```

---

## 6. Tool surface — verification‑first, judgment‑first

Reweighted from v1: **~4 strong tools carry the value (★)**; the rest are thin plumbing. (Fewer, sharper tools also dodge Copilot/VS Code's 128‑tool‑per‑request cap.)

### ★ L2 — Judgment (the reason a non‑expert can build at all)
| Tool | Sketch | Purpose |
|---|---|---|
| `aps_plan_app` | `(prompt, stack='nextjs-ts') → AppBlueprint` | **Flagship.** Maps a plain prompt to: which APS services/operations, the **auth model + scopes**, the data flow, routes/pages, env vars, and the **APS registration checklist**. This is the APS architecture decision the developer doesn't have to know. See Appendix A. |
| `aps_auth_recipe` | `(app_type, user_facing?) → AuthRecipe` | **Flagship.** Picks 2LO vs 3LO vs PKCE, and emits the *correct* code — including the **refresh‑token‑rotation fix** (see §7). Maps to the APS app‑types registry (MCP_PUBLIC / CONFIDENTIAL / SERVICE). |

### ★ L3 — Verification (the moat; how a non‑expert ships correct code)
| Tool | Sketch | Purpose |
|---|---|---|
| `aps_dry_run` | `(operation_id, sample_inputs) → result` | **Flagship.** Executes one operation against **live APS** with a bundled sample, using a **scoped, non‑destructive sandbox credential** (security — see §7). Reuses `execute_workflow`. The dev gets correctness without the expertise to audit it. |
| `aps_validate_code` | `(files) → [Issue]` | Static check: do calls exist in the registry with correct params/scopes? Flags hallucinations **and** the cookie‑only‑refresh anti‑pattern. Reuses the save‑as‑skill guard. |
| `aps_smoke_test` | `(app_dir) → report` | Runs the *assembled* app's happy path against APS sandbox via `workflow-runner`. (Phase 2 — harder than single‑op dry‑run; do not oversell `dry_run` as "the whole app works.") |

### L1 — Plumbing (commodity; generate it, don't over‑invest)
| Tool | Sketch | Purpose |
|---|---|---|
| `aps_scaffold` | `(blueprint, stack) → writes files + manifest` | Emits the starter repo from verified templates (auth route, client, Viewer, `.env.example`, `vercel.json`). **Writes to disk; returns a manifest.** |
| `aps_get_snippet` | `(operation_id, framework) → code` | Focused snippet for one touchpoint. |
| `aps_generate_client` | `(operations[], lang) → writes lib/aps/` | Typed client for the operations used (auth headers, retry, polling, OSS signed‑URL). |
| `aps_get_contract` | `(capability_id, operation_id) → Contract` | Thin contract lookup. Could be served by `llms.txt`; keep minimal. |

### Deploy (human‑gated)
| Tool | Sketch | Purpose |
|---|---|---|
| `aps_emit_deploy` | `(blueprint, target='vercel') → config + checklist` | Emits `vercel.json` + env mapping + the **"register your APS app, add this callback, set these envs"** checklist. **Deploy is gated by the developer**, not autonomous (base‑rate lesson — §7). |

---

## 7. Pressure‑test findings baked into the design

These are the load‑bearing results from the `/deepthink` review (architect + premortem, 2026‑06‑04). Each is now a design constraint, not an open risk.

1. **Codegen‑over‑MCP is a solved non‑issue.** Claude Code auto‑persists tool results >25K tokens to disk and explicitly names "full file trees" as the use case; stdio servers have full local FS access. **Pattern: server writes files to disk, returns a compact manifest.** *(code.claude.com/docs/en/mcp; MCP spec 2025‑06‑18)* — but note the disk pattern assumes a **local** agent; it does not port to chat‑only clients that can't read local disk.

2. **Auth: callback chicken‑and‑egg is SOLVED; refresh rotation is the real landmine.** APS supports 50 callbacks + HTTPS wildcard subdomains, and Auth.js infers the host — so registration is tractable. **The non‑obvious killer:** APS refresh tokens **rotate and only one is kept per user/app**; in stateless serverless, two concurrent invocations refreshing race and invalidate each other → random forced logouts. **`aps_auth_recipe` MUST emit a shared‑KV/DB refresh store with a single‑flight lock — never a cookie‑only refresh.** This is the clearest example of L2/L3 earning its keep: a naive app *works in the demo and breaks under real concurrency.* *(aps.autodesk.com/blog: wildcards‑callback‑urls, about‑refresh‑token; authjs.dev deployment)*

3. **`dry_run` is a security surface.** Agent‑driven calls with real creds = the Supabase‑MCP prompt‑injection failure class. **Use a scoped, sandbox, non‑destructive credential for verification — never the user's production app creds.** *(supabase.com/blog/defense-in-depth-mcp)*

4. **Don't sell "autonomous build+deploy."** Every product that wins prompt‑to‑deployed‑app **owns its runtime** (v0/Vercel, Cloudflare Workers, Supabase); we don't own Vercel — our value is the **APS‑correctness layer**, which is portable and Autodesk‑unique. And Stripe's own retrospective: agents build integrations well (~92%) but fail at ambiguity/recovery, so **autonomous deploy is unrealistic — keep a human gate.** *(vercel.com/blog/introducing-vercel-mcp; stripe.com/blog/can-ai-agents-build-real-stripe-integrations)*

5. **Multi‑client "interchangeable" is half‑true.** Tools work on Claude Code, Cursor, and Copilot (GA July 2025). But UI/elicitation and the write‑to‑disk pattern do **not** port cleanly, and Copilot/VS Code caps tools at 128/request. **Posture: Claude Code first, Cursor second, Copilot best‑effort.** Do not assume MCP‑Apps/elicitation work outside Claude clients. *(cursor.com/docs; github.blog changelog 2025‑07‑14; code.visualstudio.com agent‑tools)*

6. **NEW top risk — the L2 judgment layer is authored, curation‑heavy content, and it's the real cost center.** Today's registry has capabilities/operations but only *partial* intent→architecture judgment, and only 636/1,589 ops are SAFE/callable. Encoding "for intent X, use services A+B+C with auth D" is authored work, like the `/appbuilder` rules. **Underestimating this is the likeliest way the project disappoints.** Mitigation: a **beachhead** (§8), not "any APS app."

---

## 8. Beachhead — 5–8 app archetypes, not "any APS app"

The framing invites scope creep ("build *any* APS app"). Resist it. Author L2 judgment richly for a small set of archetypes the registry covers well, nail those, then expand:

1. **View a model in a browser** — OSS upload → Model Derivative (SVF2) → Viewer.
2. **Convert & download** — upload → translate/extract → signed download (e.g. DWG→PDF, sheet‑PDF).
3. **Extract properties to a dashboard** — translate → property extraction → table/chart UI.
4. **Parameter round‑trip** — view → edit parameter → Design Automation update → re‑view (mirrors RevitParameterUpdater).
5. **Model + metadata report** — translate → AEC/metadata extract → report page.
6–8. *(reserve for expansion — e.g. ACC project browser, webhook‑driven status, BOM viewer)*

Each archetype = one authored `AppBlueprint` template + sample assets + a known‑green `dry_run`/`smoke_test` path. **Coverage is the product; breadth claims without authored coverage are the trap.**

---

## 9. The Phase‑0 killer experiment (gates eng commitment)

Before building anything, run an **A/B with APS‑naive developers** — this directly tests the project's premise and is the one load‑bearing unknown no public benchmark answers.

> **Subjects:** two developers who do **not** know APS.
> **Task:** the same plain prompt (Archetype #1: "let a user upload a Revit model, view it in 3D, and download a sheet PDF").
> - **Arm 1:** coding agent + APS docs/SDK/`llms.txt`. No MCP.
> - **Arm 2:** coding agent + the companion (even a stub: `aps_plan_app` + `aps_dry_run` + `aps_auth_recipe`).
> **Metric:** did they reach a **working, deployed app *without having to learn APS*** — and how long? Did the result ship the refresh‑rotation bug?

- If **Arm 1 (docs only) already gets a naive dev there ~85%+** → L2 isn't differentiated → **pivot to Option C** (ship a great APS SDK + `llms.txt` + `/appbuilder`‑style skill) and save months.
- If **Arm 1's dev gets stuck on *which services / which auth* (L2) and Arm 2's doesn't** → premise confirmed; build §6 with conviction.

This converts the riskiest assumption into a 2–3 day test.

---

## 10. Generated‑app architecture (Next.js + TS → GitHub → Vercel)

- **Framework:** Next.js (App Router) + TypeScript.
- **APS client lib:** `lib/aps/` — generated typed client, token helper, async‑job poller, OSS signed‑URL helper.
- **Auth:** 3LO **PKCE** via route handlers; **refresh token in shared KV/DB with single‑flight lock** (per §7.2) — *not* a cookie‑only refresh. Demo may use a simplified app‑context (2LO) path, flagged by `aps_plan_app`.
- **API routes:** `app/api/*` call APS via the typed client.
- **Viewer:** client component loading the Autodesk Viewer SDK (templated from `render-model.ts`).
- **Deploy:** push to **GitHub** → Vercel auto‑deploys. Use a **stable custom domain** (APS wildcard callbacks don't match random `*.vercel.app` preview URLs; localhost can't use wildcards). Deploy once to get the URL, then register the callback (handled by the checklist).
- **Repo tree:** Appendix B.

---

## 11. Phasing & roadmap

> Demo‑first. Each phase has an explicit exit criterion.

### Phase 0 — Killer A/B experiment  *(days; gates everything)*
- Stub `aps_plan_app` + `aps_dry_run` + `aps_auth_recipe`; run the §9 A/B with APS‑naive subjects.
- **Exit / decision:** premise confirmed → proceed to Phase 1; premise fails → pivot to Option C.

### Phase 1 — Judgment + verification core  *(AU 2026 demo target)*
- Flagships: `aps_plan_app`, `aps_auth_recipe`, `aps_dry_run`, `aps_validate_code` + thin `aps_scaffold`/`aps_get_snippet`/`aps_generate_client`.
- **Claude Code only.** Next.js + TS. Beachhead archetype #1 + #2.
- Bundled sample‑asset pack + a dedicated **sandbox APS app/credential** for `dry_run`.
- **Exit:** from a single prompt, an APS‑naive operator gets a working upload→view→sheet‑PDF app, dry‑run green against live APS, deployed to Vercel — **demoable live at AU 2026.**

### Phase 2 — Trust + breadth
- `aps_smoke_test` (assembled‑app happy path); `aps_emit_deploy` (Vercel adapter, human‑gated).
- Beachhead archetypes #3–#5; web‑suitability filter on the registry.
- Cursor support certified.
- **Exit:** three archetypes build + deploy from prompts with green smoke tests on Claude Code and Cursor.

### Phase 3 — Productize / remote
- Streamable‑HTTP transport + per‑user 3LO (web‑hosted pivot); multi‑tenant session store (Redis/Postgres).
- Second stack (Python/FastAPI); Copilot best‑effort certified + per‑client setup docs.
- Optional published `@aps/workflow-engine` package for multi‑step apps.
- **Exit:** a developer connects to the hosted MCP from Cursor and ships an app with no local install.

---

## 12. AU 2026 demo definition + the stage risks

> **On stage:** presenter types one prompt into Claude Code with our MCP connected — *"Build a web app where my client uploads a Revit model, sees it in 3D, and downloads a PDF of every sheet."* The audience watches it **plan the APS architecture it didn't have to know**, scaffold, **dry‑run green against live APS**, push to GitHub, and `vercel deploy`. Presenter opens the **live Vercel URL** and it renders.

**The lead beat is "it made the APS decisions for me and tested them against real APS" — that's the L2+L3 story, and it's the differentiated one.**

Ranked stage risks (mitigate in this order):
1. **Live async `dry_run` latency/timeout** — Model Derivative translation can take minutes → dead air. **Mitigation: pre‑translate and cache the sample; never first‑translate live on stage.**
2. **Auth on stage** — use a **pre‑registered stable custom domain** + pre‑authorized app; decide demo path (full 3LO vs simplified 2LO) in Phase 1.
3. **The 90%‑right trap is *invisible in a 5‑minute demo*** — the app works on stage and hides the refresh‑rotation bug. Dangerous because it can fool *us* into thinking auth is "done." `aps_auth_recipe` must be correct regardless of what the demo reveals.

---

## 13. Risk register (top failure modes + tripwires)

| # | Failure mode | Likelihood | Blast radius | Mitigation / tripwire |
|---|--------------|-----------|--------------|------------------------|
| 1 | **L2 content under‑resourced** — judgment layer is thin, archetypes shallow | **H** | High | Beachhead (§8); fund authoring like `/appbuilder` rules; **tripwire:** if archetype #1 blueprint takes >1 wk to author well, re‑scope breadth |
| 2 | **90%‑right trap** — app works in demo, ships refresh‑rotation bug | **H** if recipe naive | High (trust) | `aps_auth_recipe` emits KV+single‑flight; `aps_validate_code` flags cookie‑only refresh |
| 3 | **Commodity collapse** — APS ships its own MCP/`llms.txt`; docs alone suffice | M | High (kills rationale) | Phase‑0 A/B; **tripwire:** APS publishes an official MCP or `llms.txt` → re‑evaluate within 30 days |
| 4 | **Live `dry_run` dies on stage** | M | High (demo) | Pre‑warm/cache sample; never first‑translate live |
| 5 | **Adoption friction** — install MCP + register APS app + Vercel + creds > value | M/H | High | Measure setup time in Phase 0; **tripwire:** if naive‑dev setup >15 min, the demo is lying about real friction |
| 6 | **`dry_run` creds abused** via poisoned prompt | M | High | Scoped sandbox, non‑destructive creds only |
| 7 | **Client parity assumed** | M | Med | Claude Code first; others labeled experimental |

---

## 14. What would make us abandon / pivot (falsifiable)

- **Abandon → Option C (SDK + `llms.txt` + skill)** if Phase‑0 Arm 1 (docs only) lets an APS‑naive dev ship a working, bug‑free app **≥ ~85%** of attempts.
- **Pivot to verification‑only MCP** if L2 contract‑serving shows <10‑pt lift but `dry_run` catches real bugs Arm 1 ships.
- **Narrow to Claude‑Code‑only permanently** if Cursor/Copilot can't reliably drive the verify loop in testing.
- **Re‑evaluate within 30 days** if Autodesk ships an official APS MCP or `llms.txt`.

---

## 15. Open questions

- Does a frontier agent + good APS docs already let an APS‑naive dev build a working APS app? *(← Phase‑0 answers this; everything hinges on it.)*
- Can `smoke_test` realistically verify an *assembled* app's happy path, or only single ops?
- Where do the `dry_run` sample assets + sandbox credential live, and who owns that test APS app?
- How big is the target population — "web devs who want APS capability but don't know APS"? *(opportunity‑sizing; informs internal sponsorship)*
- Generated apps: typed client (no runtime dep on us) vs. a published `@aps/workflow-engine` package for multi‑step apps? *(decide at Phase 2)*

---

## Appendix A — `AppBlueprint` schema (draft)

```jsonc
{
  "prompt": "user uploads a Revit model, views it, downloads a sheet PDF",
  "archetype": "view-a-model + convert-and-download",   // L2: matched to a beachhead archetype
  "stack": "nextjs-ts",
  "operations": [
    { "capability_id": "...", "operation_id": "oss-upload",         "purpose": "ingest" },
    { "capability_id": "...", "operation_id": "translate-to-svf2",  "purpose": "viewer" },
    { "capability_id": "...", "operation_id": "extract-sheets-pdf", "purpose": "download" }
  ],
  "auth": {                                  // L2: the decision the dev didn't have to make
    "strategy": "3lo-pkce",                  // 2lo | 3lo | 3lo-pkce
    "app_type": "MCP_PUBLIC",
    "scopes": ["data:read","data:write","data:create","viewables:read"],
    "user_facing": true,
    "refresh_storage": "shared-kv-single-flight"   // L3: the non-obvious correctness requirement
  },
  "routes": [
    { "path": "/upload",        "kind": "page" },
    { "path": "/api/translate", "kind": "route", "ops": ["oss-upload","translate-to-svf2"] },
    { "path": "/api/status",    "kind": "route", "ops": ["translate-status"] },
    { "path": "/api/sheets",    "kind": "route", "ops": ["extract-sheets-pdf"] },
    { "path": "/viewer/[urn]",  "kind": "page",  "component": "ApsViewer" }
  ],
  "env": ["APS_CLIENT_ID","APS_PKCE_CALLBACK_URL","APS_BUCKET","KV_URL"],
  "deploy": { "target": "vercel", "repo": "github", "domain": "stable-custom-domain-required" },
  "registration_checklist": [
    "Create an APS app of type MCP_PUBLIC in the Developer Portal",
    "Deploy once to Vercel; attach a STABLE custom domain (wildcard callbacks don't match *.vercel.app)",
    "Register callback https://<your-domain>/api/auth/callback",
    "Set APS_CLIENT_ID + KV_URL as Vercel env vars"
  ],
  "irreducible_floor": "developer must create the APS app + authorize scopes; companion guides, can't eliminate"
}
```

## Appendix B — generated repo tree (Next.js + TS)

```
my-aps-app/
├─ app/
│  ├─ page.tsx                     # upload UI
│  ├─ viewer/[urn]/page.tsx        # Autodesk Viewer page
│  └─ api/
│     ├─ auth/callback/route.ts    # PKCE callback handler
│     ├─ translate/route.ts        # OSS upload + SVF2 translate
│     ├─ status/route.ts           # manifest polling
│     └─ sheets/route.ts           # sheet-PDF extraction
├─ lib/aps/
│  ├─ client.ts                    # generated typed APS client
│  ├─ auth.ts                      # token + REFRESH (shared KV + single-flight lock)
│  ├─ poll.ts                      # async-job polling helper
│  └─ oss.ts                       # signed-URL helper
├─ components/ApsViewer.tsx        # Viewer SDK wrapper (from render-model.ts)
├─ .env.example
├─ vercel.json
├─ package.json
└─ README.md                       # incl. APS registration checklist + irreducible-floor note
```

---

*End of design doc v2. No implementation has been started. Eng commitment is gated on the Phase‑0 A/B experiment (§9).*
