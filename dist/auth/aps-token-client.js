const APS_TOKEN_URL = "https://developer.api.autodesk.com/authentication/v2/token";
export class APSAuthError extends Error {
    statusCode;
    apsCode;
    constructor(message, statusCode, apsCode) {
        super(message);
        this.statusCode = statusCode;
        this.apsCode = apsCode;
        this.name = "APSAuthError";
    }
}
export async function getTwoLeggedToken(clientId, clientSecret, scopes) {
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
    const json = (await response.json());
    if (!response.ok) {
        const msg = json.errorMessage ?? json.error_description ?? json.error ?? response.statusText;
        throw new APSAuthError(`APS authentication failed: ${msg}`, response.status, json.errorCode ?? json.error);
    }
    return json;
}
