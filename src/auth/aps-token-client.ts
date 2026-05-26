const APS_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";

export interface APSTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;       // APS echoes back the granted scopes
}

export interface APSErrorResponse {
  errorCode?: string;
  errorMessage?: string;
  error?: string;
  error_description?: string;
}

export class APSAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apsCode?: string
  ) {
    super(message);
    this.name = "APSAuthError";
  }
}

export async function getTwoLeggedToken(
  clientId: string,
  clientSecret: string,
  scopes: string[]
): Promise<APSTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes.join(" "),
  });

  const response = await fetch(APS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = (await response.json()) as APSTokenResponse & APSErrorResponse;

  if (!response.ok) {
    const msg =
      json.errorMessage ?? json.error_description ?? json.error ?? response.statusText;
    throw new APSAuthError(
      `APS authentication failed: ${msg}`,
      response.status,
      json.errorCode ?? json.error
    );
  }

  return json;
}
