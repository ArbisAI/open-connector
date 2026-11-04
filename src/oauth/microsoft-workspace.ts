import type { ConnectionService, ManagedConnectionSummary } from "../connection-service.ts";

import { ConnectionError } from "../connection-service.ts";
import {
  createProviderFetch,
  providerFetch,
  runProviderRequest,
  ProviderRequestError,
} from "../providers/provider-runtime.ts";
import { microsoftValidationTimeoutMs } from "./microsoft-profile.ts";

const scopes: Record<string, string[]> = {
  outlook: ["User.Read", "Mail.ReadWrite", "Mail.Send"],
  outlook_calendar: ["User.Read", "Calendars.ReadWrite"],
};

/** Create retry-safe child credentials after the backend has verified company ownership. */
export async function materializeMicrosoftAccount(
  connections: ConnectionService,
  rootId: string,
  service: string,
  subject: string,
  fetcher: typeof fetch = providerFetch,
): Promise<ManagedConnectionSummary> {
  const required = scopes[service];
  const root = await connections.getStoredConnection(rootId);
  if (!required || root.service !== "microsoft365" || root.credential?.authType !== "oauth2")
    throw new ConnectionError("invalid_input", "A Microsoft email or calendar authorization is required.");
  const profile = root.credential.profile;
  if (
    !profile.microsoftTenantId ||
    !profile.microsoftObjectId ||
    subject !== `microsoft:${profile.microsoftTenantId}:${profile.microsoftObjectId}`
  )
    throw new ConnectionError("invalid_input", "Microsoft account identity does not match.");
  if (!required.every((scope) => profile.grantedScopes.includes(scope)))
    throw new ConnectionError("scope_missing", "Microsoft did not grant all requested permissions.");
  const alias = `microsoft-${root.id}-${service}`;
  try {
    return await connections.getManagedConnectionByAlias(service, alias);
  } catch (error) {
    if (!(error instanceof ConnectionError) || error.code !== "connection_not_found") throw error;
  }
  const credential = await connections.prepareOAuthCredential(service, root.credential);
  if (
    credential.profile.microsoftTenantId !== profile.microsoftTenantId ||
    credential.profile.microsoftObjectId !== profile.microsoftObjectId
  )
    throw new ConnectionError("invalid_input", "Microsoft account identity changed.");
  const mailbox = service === "outlook" ? "messages" : "calendars";
  const response = await runProviderRequest(
    { label: "Microsoft mailbox validation", timeoutMs: microsoftValidationTimeoutMs },
    (signal) =>
      createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(
        `https://graph.microsoft.com/v1.0/me/${mailbox}?$top=1&$select=id`,
        { headers: { Authorization: `Bearer ${credential.accessToken}` }, signal },
      ),
  );
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429)
      throw new ProviderRequestError(503, "Microsoft mailbox validation is temporarily unavailable. Retry connecting.");
    throw new ConnectionError(
      "microsoft_mailbox_unavailable",
      "Microsoft could not confirm mailbox access. Use an account with an active Outlook mailbox and the required permissions.",
    );
  }
  const saved = await connections.savePreparedOAuthCredential(service, credential, alias);
  return connections.getManagedConnection(saved.id);
}
