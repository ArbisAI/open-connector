import type { ConnectionService, ManagedConnectionSummary } from "../connection-service.ts";

import { ConnectionError } from "../connection-service.ts";

/**
 * The scopes that each prove a child service was actually consented to. Any one
 * of a service's entries is enough: a least-privilege host may authorize
 * `calendar.events.freebusy` for availability lookups instead of the sensitive
 * `calendar.readonly`, and that grant must still materialize the calendar
 * account. A scope listed here only decides whether the child connection is
 * created — each action still declares and enforces its own required scopes.
 */
const readScopes: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
  googlecalendar: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ],
};

/** Materialize an idempotent child account without returning OAuth secrets. Admin API only. */
export async function materializeGoogleAccount(
  connections: ConnectionService,
  rootId: string,
  service: string,
  email: string,
): Promise<ManagedConnectionSummary | null> {
  const accepted = readScopes[service];
  if (!accepted) throw new ConnectionError("invalid_input", "Only email and calendar are supported.");
  const root = await connections.getStoredConnection(rootId);
  if (
    root.service !== "googleworkspace" ||
    root.credential?.authType !== "oauth2" ||
    root.credential.profile.accountId.toLowerCase() !== email.toLowerCase()
  ) {
    throw new ConnectionError("invalid_input", "The Google account does not match the signed-in account.");
  }
  const granted = root.credential.profile.grantedScopes;
  if (!accepted.some((scope) => granted.includes(scope))) return null;
  if (!root.credential.profile.googleSubject || root.credential.profile.emailVerified !== true) {
    throw new ConnectionError("invalid_input", "The Google account identity has not been verified.");
  }
  const alias = `google-${root.id}-${service}`;
  // Retry recovery never overwrites a newer or reauthorized child credential.
  try {
    return await connections.getManagedConnectionByAlias(service, alias);
  } catch (error) {
    if (!(error instanceof ConnectionError) || error.code !== "connection_not_found") throw error;
  }
  // Validate as the child service before inserting. A failed child check must not persist the parent profile.
  const credential = await connections.prepareOAuthCredential(service, root.credential);
  if (
    credential.profile.emailVerified !== true ||
    !credential.profile.googleSubject ||
    credential.profile.accountId.toLowerCase() !== email.toLowerCase()
  ) {
    throw new ConnectionError("invalid_input", "The Google account identity has not been verified.");
  }
  const saved = await connections.savePreparedOAuthCredential(service, credential, alias);
  return connections.getManagedConnection(saved.id);
}
