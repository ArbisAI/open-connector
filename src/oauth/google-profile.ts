import type { CredentialProfileInput, ResolvedCredential, CredentialValidatorOptions } from "../core/types.ts";

import { createProviderFetch, ProviderRequestError } from "../providers/provider-runtime.ts";

/** Provider-verified identity metadata only; no mailbox or calendar content is read. */
export async function googleProfile(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  { fetcher, signal }: CredentialValidatorOptions,
): Promise<CredentialProfileInput> {
  const response = await createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${input.accessToken}` }, signal },
  );
  if (!response.ok) throw new ProviderRequestError(401, "Google identity could not be verified.");
  const profile = (await response.json()) as { email?: string; email_verified?: boolean; sub?: string; hd?: string };
  if (!profile.email || !profile.sub || profile.email_verified !== true)
    throw new ProviderRequestError(401, "A verified Google email is required.");
  return {
    accountId: profile.email.toLowerCase(),
    displayName: profile.email,
    googleSubject: profile.sub,
    hostedDomain: profile.hd,
    emailVerified: true,
    grantedScopes: typeof input.metadata.scope === "string" ? input.metadata.scope.split(/\s+/) : [],
  };
}
