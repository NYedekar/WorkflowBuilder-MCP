# WorkflowSkills MCP

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude work directly with Autodesk files and APS cloud services — translating models for the Autodesk Viewer, extracting metadata, running Design Automation jobs, and calling APS REST APIs, all from a conversation.

## What it does

Drop a DWG, RVT, IPT, IFC, or any other Autodesk file into Claude and ask it to:

- **Translate** the file to SVF2 for viewing in the Autodesk Viewer
- **Extract metadata** — element properties, layers, layouts, drawing stats, block attributes, assembly BOM, and more
- **Run Design Automation** (AutoCAD, Revit, Inventor) WorkItems for deeper processing
- **Call APS REST APIs** — Model Derivative, Data Management, OSS, and others — without writing any code

Supported file types: `RVT RFA DWG DXF DWF DWFX IPT IAM IDW F3D NWD NWC IFC FBX STEP STP IGES SAT OBJ STL RCP E57 LAS` and more.

## Tools

| Tool | Description |
|---|---|
| `get_capability` | Search 260+ capabilities across Design Automation and APS REST APIs |
| `authenticate_aps` | Verify APS credentials and cache a token |
| `process_file` | One-call workflow: upload → translate/run → return results |
| `execute_workflow` | Run a specific capability operation (REST call or DA WorkItem) |
| `upload_file` | Upload a local file to APS OSS |
| `get_result` | Download output from APS OSS after a job completes |
| `get_workflow_status` | Poll a running DA WorkItem |
| `create_workflow` | Build a multi-step pipeline across capabilities |
| `export_workflow` | Export a pipeline definition |

## Prerequisites

- [Node.js](https://nodejs.org) v18 or later
- [Claude Desktop](https://claude.ai/download) or [Claude Code](https://claude.ai/code)
- An APS application with a Client ID and Client Secret — create one free at [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps)

## Installation

### 1. Clone and build

```bash
git clone https://github.com/NYedekar/WorkflowSkills-MCP.git
cd WorkflowSkills-MCP
npm install
npm run build
```

### 2. Run the setup wizard

The setup script validates your APS credentials, stores the secret securely in the OS keychain, and writes the MCP config into Claude automatically.

```bash
npm run setup
```

You will be prompted for your APS Client ID and Client Secret. The secret is stored in the OS keychain and never written to any file.

### 3. Restart Claude

Fully quit and relaunch Claude Desktop or Claude Code. The `workflow-builder` server will appear in your MCP tools list.

---

### Manual configuration (alternative to the setup wizard)

If you prefer to configure manually, add the following to your `~/.claude.json` under `"mcpServers"`:

```json
"workflow-builder": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/WorkflowSkills-MCP/dist/index.js"],
  "env": {
    "APS_CLIENT_ID": "YOUR_CLIENT_ID",
    "APS_CLIENT_SECRET": "YOUR_CLIENT_SECRET"
  }
}
```

Replace `/path/to/WorkflowSkills-MCP` with the actual path where you cloned the repo. Run `which node` to find your Node.js path if needed.

## Quick start

Once installed, open Claude and try:

> *"Translate this DWG for the Autodesk Viewer and extract its metadata."*

Claude will automatically detect the file type, call `get_capability`, authenticate, upload, translate, and return the results — including a ready-to-open `viewer.html`.

## APS application setup

1. Go to [aps.autodesk.com/myapps](https://aps.autodesk.com/myapps) and sign in
2. Click **Create Application**
3. Select the APIs you need (at minimum: **Model Derivative API**, **Data Management API**)
4. Copy the **Client ID** and **Client Secret**
5. Pass them to `npm run setup` or add them to your `~/.claude.json` manually

> **Note:** Each user needs their own APS application and credentials. Do not share Client Secrets.

## Development

```bash
npm run dev      # run from source with tsx (no build step)
npm run build    # compile TypeScript → dist/
```

## License

MIT
