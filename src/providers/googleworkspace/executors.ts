import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { createProviderFetch, ProviderRequestError } from "../provider-runtime.ts";

export const executors: ProviderExecutors = {};
export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const response = await createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${input.accessToken}` }, signal },
    );
    if (!response.ok) throw new ProviderRequestError(401, "Google identity could not be verified.");
    const profile = (await response.json()) as { email?: string; email_verified?: boolean };
    if (!profile.email || profile.email_verified !== true)
      throw new ProviderRequestError(401, "A verified Google email is required.");
    // The token response, never the requested scopes, is authoritative for partial consent.
    const scopes = typeof input.metadata.scope === "string" ? input.metadata.scope.split(/\s+/) : [];
    return { profile: { accountId: profile.email.toLowerCase(), displayName: profile.email, grantedScopes: scopes } };
  },
};
