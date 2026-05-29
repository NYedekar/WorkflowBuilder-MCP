import { z } from "zod";
import { getTwoLeggedToken, APSAuthError } from "../auth/aps-token-client.js";
import { loadSecret, storeSecret } from "../auth/keychain.js"; // synchronous
import { setCachedToken } from "../auth/token-cache.js";
import { DEFAULT_SCOPES } from "../auth/credential-resolver.js";
import { getSessionRecoverySummary } from "../lib/session-store.js";

export const authenticateApsSchema = z.object({
  store_to_keychain: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Store the client secret to the OS keychain so future MCP restarts " +
        "don't need APS_CLIENT_SECRET in the env block. Default: true."
    ),
  scopes: z
    .array(z.string())
    .optional()
    .describe(
      "APS OAuth scopes to request. Defaults to: data:read, data:write, " +
        "data:create, bucket:create, bucket:read, bucket:update."
    ),
});

export type AuthenticateApsInput = z.infer<typeof authenticateApsSchema>;

export interface AuthenticateApsResult {
  status: "authenticated" | "error";
  client_id?: string;
  scopes_granted?: string[];
  access_token_expires_in?: number;
  keychain_stored?: boolean;
  session_recovery?: string; // human-readable summary of recoverable jobs from a prior server instance
  _resume_handles?: Array<{ type: string; workItemId: string; outputOssUrls: string[] }>; // pass directly as workflow_handle to get_workflow_status
  error?: string;
  hint?: string;
}

export async function handleAuthenticateAps(
  input: AuthenticateApsInput
): Promise<AuthenticateApsResult> {
  const clientId = process.env.APS_CLIENT_ID?.trim();

  if (!clientId) {
    return {
      status: "error",
      error: "Missing environment variable: APS_CLIENT_ID",
      hint:
        "Run the setup script to configure credentials:\n" +
        "  cd <mcp-workflow-builder dir> && npm run setup\n" +
        "Then restart Claude Code so the MCP picks up the new values.",
    };
  }

  // Secret priority: OS keychain → APS_CLIENT_SECRET env var
  const clientSecret =
    loadSecret(clientId) ?? process.env.APS_CLIENT_SECRET?.trim() ?? null;

  if (!clientSecret) {
    return {
      status: "error",
      error: "APS client secret not found in keychain or environment.",
      hint:
        "Run the setup script to store your credentials:\n" +
        "  cd <mcp-workflow-builder dir> && npm run setup\n" +
        "Then restart Claude Code.",
    };
  }

  const scopes = input.scopes ?? DEFAULT_SCOPES;

  try {
    const token = await getTwoLeggedToken(clientId, clientSecret, scopes);

    // Warm the in-process token cache so the first execute_workflow call is instant.
    const cacheKey = `2lo:${clientId}:${scopes.slice().sort().join(",")}`;
    setCachedToken(cacheKey, token.access_token, token.expires_in);

    // Optionally promote the secret to keychain so APS_CLIENT_SECRET can be
    // removed from the mcp.json env block after first setup.
    let keychainStored = false;
    if (input.store_to_keychain) {
      keychainStored = storeSecret(clientId, clientSecret);
    }

    const recovery = getSessionRecoverySummary();
    return {
      status: "authenticated",
      client_id: clientId,
      scopes_granted: scopes,
      access_token_expires_in: token.expires_in,
      keychain_stored: keychainStored,
      ...(recovery ? { session_recovery: recovery.summary, _resume_handles: recovery.handles } : {}),
    };
  } catch (err) {
    if (err instanceof APSAuthError) {
      const hint =
        err.statusCode === 401
          ? "Check that your client_id and client_secret are correct and that the app is active in the APS Developer Portal."
          : err.statusCode === 403
            ? "The app may not have the requested scopes enabled. Check your APS app settings."
            : undefined;

      return { status: "error", error: err.message, hint };
    }
    return {
      status: "error",
      error: String(err),
    };
  }
}
