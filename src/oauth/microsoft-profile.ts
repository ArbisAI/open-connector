import type { CredentialProfileInput, ResolvedCredential, CredentialValidatorOptions } from "../core/types.ts";

import { optionalRecord, optionalString } from "../core/cast.ts";
import { createProviderFetch, ProviderRequestError, runProviderRequest } from "../providers/provider-runtime.ts";
import { microsoftGraphAccountMatches, microsoftPersonalTenant } from "./microsoft-identity.ts";

/** Identity and mailbox checks share the backend's 30-second connection request budget. */
export const microsoftValidationTimeoutMs = 10_000;

/** Graph owns account labels; only a validated ID token supplies the tenant identity. */
export async function microsoftProfile(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  { fetcher, signal }: CredentialValidatorOptions,
): Promise<CredentialProfileInput> {
  const identity = optionalRecord(input.metadata.microsoftIdentity);
  const objectId = optionalString(identity?.objectId);
  const tenantId = optionalString(identity?.tenantId);
  const fields =
    tenantId === microsoftPersonalTenant
      ? "id,displayName,mail,userPrincipalName"
      : "id,displayName,mail,userPrincipalName,userType";
  const account = await runProviderRequest(
    { label: "Microsoft identity validation", signal, timeoutMs: microsoftValidationTimeoutMs },
    async (requestSignal) => {
      const response = await createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(
        `https://graph.microsoft.com/v1.0/me?$select=${fields}`,
        {
          headers: { Authorization: `Bearer ${input.accessToken}` },
          signal: requestSignal,
        },
      );
      if (!response.ok) throw new ProviderRequestError(response.status, "Microsoft account could not be verified.");
      return optionalRecord(await response.json()) ?? {};
    },
  );
  const accountId = optionalString(account.id);
  if (!accountId) throw new ProviderRequestError(401, "Microsoft returned no account identifier.");
  if (identity && (!objectId || !tenantId || !microsoftGraphAccountMatches(tenantId, objectId, accountId)))
    throw new ProviderRequestError(401, "Microsoft mailbox and authorized account do not match.");
  const principal = optionalString(account.userPrincipalName);
  const mail = optionalString(account.mail);
  return {
    accountId,
    displayName: mail ?? principal ?? optionalString(account.displayName) ?? accountId,
    microsoftObjectId: objectId,
    microsoftTenantId: tenantId,
    microsoftPrincipalName: tenantId === microsoftPersonalTenant ? (mail ?? principal) : principal,
    microsoftMail: mail,
    microsoftUserType: optionalString(account.userType),
    grantedScopes:
      typeof input.metadata.scope === "string"
        ? input.metadata.scope
            .split(/\s+/)
            .filter(Boolean)
            .map((scope) => scope.replace(/^https:\/\/graph.microsoft.com\//i, ""))
        : input.profile.grantedScopes,
  };
}
