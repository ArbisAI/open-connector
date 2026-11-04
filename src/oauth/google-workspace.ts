import type { ConnectionService, ManagedConnectionSummary } from "../connection-service.ts";

import { ConnectionError } from "../connection-service.ts";

const readScope: Record<string, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  googlecalendar: "https://www.googleapis.com/auth/calendar.readonly",
};

/** Materialize an idempotent child account without returning OAuth secrets. Admin API only. */
export async function materializeGoogleAccount(
  connections: ConnectionService,
  rootId: string,
  service: string,
  email: string,
): Promise<ManagedConnectionSummary | null> {
  const required = readScope[service];
  if (!required) throw new ConnectionError("invalid_input", "Only email and calendar are supported.");
  const root = await connections.getStoredConnection(rootId);
  if (
    root.service !== "googleworkspace" ||
    root.credential?.authType !== "oauth2" ||
    root.credential.profile.accountId.toLowerCase() !== email.toLowerCase()
  ) {
    throw new ConnectionError("invalid_input", "The Google account does not match the signed-in account.");
  }
  if (!root.credential.profile.grantedScopes.includes(required)) return null;
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
