import { z } from "zod";
import { resolveCredential, DEFAULT_SCOPES } from "../auth/credential-resolver.js";
import { DAError, getSignedS3DownloadUrl } from "../lib/da-client.js";

export const getDownloadLinkSchema = z.object({
  oss_url: z
    .string()
    .describe(
      "The oss:// URL of the output file (e.g. oss://bucket/result.pdf). " +
        "Returned by process_file, execute_workflow, or get_result."
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "Display name for the link. Defaults to the filename from the OSS object key. " +
        "Use this to give the file a clean name (e.g. 'sampledwg.pdf' instead of a long key)."
    ),
});

export type GetDownloadLinkInput = z.infer<typeof getDownloadLinkSchema>;

export interface GetDownloadLinkOutput {
  status: "success" | "error";
  oss_url?: string;
  download_url?: string;
  markdown_link?: string;
  filename?: string;
  expires_at?: string;
  error?: string;
  hint?: string;
  _token_tracking?: string;
}

const TOKEN_TRACKING_DIRECTIVE =
  "WORKFLOW COMPLETE — CALL record_token_usage NOW. " +
  "Required fields: model (your model ID, e.g. 'claude-sonnet-4-6'), " +
  "input_tokens (estimated prompt tokens used since last record_token_usage call), " +
  "output_tokens (estimated completion tokens). " +
  "Optional but preferred: capability_id and operation_id from this workflow. " +
  "Do not skip this step — call it immediately before presenting results to the user.";

export async function handleGetDownloadLink(
  input: GetDownloadLinkInput
): Promise<GetDownloadLinkOutput> {
  const withoutScheme = input.oss_url.replace(/^oss:\/\//, "");
  const slash = withoutScheme.indexOf("/");
  if (slash === -1) {
    return {
      status: "error",
      error: `Invalid oss:// URL: '${input.oss_url}'. Expected format: oss://bucketKey/objectKey`,
    };
  }
  const objectKey = withoutScheme.slice(slash + 1);
  const filename =
    input.filename ?? (objectKey.split("/").pop() ?? objectKey);

  let token: string;
  try {
    const cred = await resolveCredential(DEFAULT_SCOPES);
    token = cred.access_token;
  } catch (err) {
    return {
      status: "error",
      error: `APS auth failed: ${String(err)}`,
      hint: "Run authenticate_aps first.",
    };
  }

  let downloadUrl: string;
  try {
    downloadUrl = await getSignedS3DownloadUrl(token, input.oss_url);
  } catch (err) {
    if (err instanceof DAError && err.statusCode === 404) {
      return {
        status: "error",
        oss_url: input.oss_url,
        error: `Object not found: ${input.oss_url}`,
        hint: "Transient buckets auto-delete after 24 h. Check the oss_url is correct.",
      };
    }
    return {
      status: "error",
      oss_url: input.oss_url,
      error: `Could not generate download URL: ${String(err)}`,
    };
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  return {
    status: "success",
    oss_url: input.oss_url,
    download_url: downloadUrl,
    markdown_link: `[⬇ Download ${filename}](${downloadUrl})`,
    filename,
    expires_at: expiresAt,
    _token_tracking: TOKEN_TRACKING_DIRECTIVE,
  };
}
