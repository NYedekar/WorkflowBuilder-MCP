#!/usr/bin/env node
/**
 * Interactive first-time setup for mcp-workflow-builder.
 *
 * What it does:
 *   1. Prompts for APS Client ID and Client Secret (secret input is hidden on TTY).
 *   2. Validates credentials against the APS token endpoint.
 *   3. Stores the client secret in the OS keychain (primary secure storage).
 *   4. Writes APS_CLIENT_ID into ~/.claude/.mcp.json env block.
 *      The secret is NOT written to any file — keychain is the sole store.
 *   5. If the keychain is unavailable, falls back to writing both to mcp.json
 *      and warns the user.
 */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTwoLeggedToken, APSAuthError } from "./auth/aps-token-client.js";
import { storeSecret } from "./auth/keychain.js";
import { VALIDATION_SCOPE_CANDIDATES } from "./auth/credential-resolver.js";
// ─── Terminal helpers ─────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
function print(msg) {
    process.stdout.write(msg + "\n");
}
function prompt(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
function promptHidden(label) {
    // TTY path: intercept raw keystrokes so the secret is never echoed.
    if (process.stdin.isTTY) {
        return new Promise((resolve) => {
            process.stdout.write(label);
            const chars = [];
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding("utf8");
            const ENTER_CR = "\r";
            const ENTER_LF = "\n";
            const CTRL_C = "";
            const BS_1 = "";
            const BS_2 = "";
            function onData(key) {
                if (key === ENTER_CR || key === ENTER_LF) {
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener("data", onData);
                    process.stdout.write("\n");
                    resolve(chars.join(""));
                }
                else if (key === CTRL_C) {
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener("data", onData);
                    process.stdout.write("\n");
                    print(`\n${RED}Cancelled.${RESET}`);
                    process.exit(1);
                }
                else if (key === BS_1 || key === BS_2) {
                    if (chars.length > 0) {
                        chars.pop();
                        process.stdout.write("\b \b");
                    }
                }
                else {
                    chars.push(key);
                    process.stdout.write("*");
                }
            }
            process.stdin.on("data", onData);
        });
    }
    // Non-TTY fallback (piped input, CI): read via readline.
    // Input is visible in the stream — acceptable since there is no interactive user.
    print(`${YELLOW}(non-interactive — input visible)${RESET}`);
    return prompt(label);
}
// ─── ~/.claude.json updater ──────────────────────────────────────────────
//
// Claude Code CLI reads MCP server config (including env vars) from
// ~/.claude.json — NOT from ~/.claude/.mcp.json or ~/.claude/settings.json.
// We patch the env block there so APS_CLIENT_ID is injected into the MCP
// subprocess on the next Claude Code restart. The secret is never written.
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
const MCP_SERVER_KEY = "workflow-builder";
function updateMcpJson(clientId, clientSecret) {
    try {
        let config = {};
        try {
            config = JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf8"));
        }
        catch {
            // File doesn't exist yet — start fresh.
        }
        config.mcpServers ??= {};
        const srv = config.mcpServers[MCP_SERVER_KEY] ??= {};
        // Ensure env is a dict, not the empty-list default Claude Code sometimes writes.
        if (!srv.env || Array.isArray(srv.env)) {
            srv.env = {};
        }
        srv.env["APS_CLIENT_ID"] = clientId;
        // Only write the secret to the file if keychain storage failed.
        if (clientSecret) {
            srv.env["APS_CLIENT_SECRET"] = clientSecret;
        }
        writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
        return { success: true, path: CLAUDE_JSON_PATH };
    }
    catch (err) {
        return { success: false, path: CLAUDE_JSON_PATH, error: String(err) };
    }
}
function loadFromFile(filePath) {
    let raw;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch (err) {
        print(`${RED}Cannot read file: ${filePath}${RESET}`);
        print(`  ${String(err)}`);
        process.exit(1);
    }
    // Strip any leading non-JSON lines (e.g. "Contents:" headers).
    const jsonStart = raw.indexOf("{");
    const jsonText = jsonStart > 0 ? raw.slice(jsonStart) : raw;
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        print(`${RED}File is not valid JSON: ${filePath}${RESET}`);
        process.exit(1);
    }
    const clientId = parsed.client_id?.trim();
    const clientSecret = parsed.client_secret?.trim();
    if (!clientId || !clientSecret) {
        print(`${RED}File must contain both "client_id" and "client_secret" fields.${RESET}`);
        process.exit(1);
    }
    return { clientId, clientSecret };
}
// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
    // --file <path>  →  load credentials from a JSON file, skip interactive prompts.
    const fileFlag = process.argv.indexOf("--file");
    const filePath = fileFlag !== -1 ? process.argv[fileFlag + 1] : undefined;
    print("");
    print(`${BOLD}Autodesk Platform Services — mcp-workflow-builder Setup${RESET}`);
    print("─".repeat(55));
    let clientId;
    let clientSecret;
    if (filePath) {
        // Non-interactive path: load from JSON file.
        print(`Loading credentials from: ${DIM}${filePath}${RESET}`);
        ({ clientId, clientSecret } = loadFromFile(filePath));
        print(`Client ID:     ${DIM}${clientId}${RESET}`);
        print(`Client Secret: ${DIM}${"*".repeat(8)}${RESET}`);
        print("");
    }
    else {
        // Interactive path.
        print(`Get your credentials at: ${DIM}https://aps.autodesk.com/myapps/${RESET}`);
        print("Create an app → Server-to-Server (2-Legged OAuth).");
        print("");
        clientId = await prompt(`${BOLD}Client ID:${RESET}     `);
        if (!clientId) {
            print(`${RED}Client ID cannot be empty.${RESET}`);
            process.exit(1);
        }
        clientSecret = await promptHidden(`${BOLD}Client Secret:${RESET} `);
        if (!clientSecret) {
            print(`${RED}Client Secret cannot be empty.${RESET}`);
            process.exit(1);
        }
        print("");
    }
    process.stdout.write("Validating credentials… ");
    let validatedScopes = [];
    let validated = false;
    for (const scopes of VALIDATION_SCOPE_CANDIDATES) {
        try {
            const token = await getTwoLeggedToken(clientId, clientSecret, scopes);
            validatedScopes = token.scope ? token.scope.split(" ") : scopes;
            validated = true;
            print(`${GREEN}✓ Valid${RESET}  (token expires in ${token.expires_in}s)`);
            print(`  Scopes granted: ${DIM}${validatedScopes.join(", ") || "(none returned)"}${RESET}`);
            break;
        }
        catch (err) {
            if (err instanceof APSAuthError && err.apsCode === "AUTH-001") {
                // Scope not available for this app — try the next candidate.
                continue;
            }
            // Any other error (wrong credentials, network, etc.) — fail immediately.
            const msg = err instanceof Error ? err.message : String(err);
            print(`${RED}✗ Failed${RESET}`);
            print(`  ${msg}`);
            print("");
            print("Double-check your credentials in the APS Developer Portal and try again.");
            process.exit(1);
        }
    }
    if (!validated) {
        print(`${RED}✗ Failed${RESET}`);
        print("  No API products are enabled on this app.");
        print("");
        print("In the APS Developer Hub, open the app and enable the API products");
        print("(e.g. MCP_API, Data Management) then re-run setup.");
        process.exit(1);
    }
    // Store secret to keychain.
    print("");
    process.stdout.write("Storing secret to OS keychain… ");
    const keychainOk = storeSecret(clientId, clientSecret);
    let secretInFile = false;
    if (keychainOk) {
        print(`${GREEN}✓${RESET}`);
    }
    else {
        print(`${YELLOW}⚠ Keychain unavailable${RESET}`);
        print(`  ${DIM}The client secret will be written to ~/.claude/.mcp.json instead.${RESET}`);
        print(`  ${DIM}This is acceptable on a personal machine but less secure than the keychain.${RESET}`);
        secretInFile = true;
    }
    // Update ~/.claude.json (the Claude Code CLI user config).
    process.stdout.write("Updating ~/.claude.json… ");
    const result = updateMcpJson(clientId, secretInFile ? clientSecret : undefined);
    if (result.success) {
        print(`${GREEN}✓${RESET}`);
    }
    else {
        print(`${YELLOW}⚠ Could not auto-update${RESET}`);
        print(`  ${result.error}`);
        print("");
        print("Add this manually to your ~/.claude.json under mcpServers.workflow-builder.env:");
        print("");
        const envBlock = { APS_CLIENT_ID: clientId };
        if (secretInFile)
            envBlock["APS_CLIENT_SECRET"] = clientSecret;
        print(JSON.stringify({ env: envBlock }, null, 2));
    }
    print("");
    print(`${GREEN}${BOLD}Setup complete.${RESET}`);
    print("");
    print("Next steps:");
    print("  1. Restart Claude Code (so the MCP picks up the new env vars).");
    if (keychainOk) {
        print("  2. The secret is in your keychain — no credentials remain in any config file.");
    }
    print(`  3. In Claude, run: ${BOLD}authenticate_aps${RESET} to confirm the connection.`);
    print("");
}
main().catch((err) => {
    print(`\n${RED}Fatal error: ${String(err)}${RESET}`);
    process.exit(1);
});
