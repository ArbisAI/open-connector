import type { CredentialProfileInput, ResolvedCredential, CredentialValidatorOptions } from "../core/types.ts";

import { createProviderFetch, ProviderRequestError } from "../providers/provider-runtime.ts";

const googleUserInfoUrl = "https://openidconnect.googleapis.com/v1/userinfo";
const gmailProfileUrl = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** Provider-verified identity metadata only; no mailbox or calendar content is read. */
export async function googleProfile(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  options: CredentialValidatorOptions,
): Promise<CredentialProfileInput> {
  const grantedScopes = grantedScopeList(input);
  // Identity scopes can call userinfo. A mailbox-only token cannot, so prove that account
  // through Gmail and do not advertise OpenID claims the token did not verify.
  if (grantedScopes.some((scope) => scope === "openid" || scope === "email" || scope === "profile")) {
    return openIdProfile(input, options, grantedScopes);
  }
  if (grantedScopes.some((scope) => scope.startsWith("https://www.googleapis.com/auth/gmail."))) {
    return gmailAccountProfile(input, options, grantedScopes);
  }
  return openIdProfile(input, options, grantedScopes);
}

async function openIdProfile(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  { fetcher, signal }: CredentialValidatorOptions,
  grantedScopes: string[],
): Promise<CredentialProfileInput> {
  const response = await createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(googleUserInfoUrl, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal,
  });
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
    grantedScopes,
  };
}

async function gmailAccountProfile(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  { fetcher, signal }: CredentialValidatorOptions,
  grantedScopes: string[],
): Promise<CredentialProfileInput> {
  const response = await createProviderFetch({ fetch: fetcher, skipDnsValidation: true })(gmailProfileUrl, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
    signal,
  });
  if (!response.ok) throw new ProviderRequestError(401, "Google identity could not be verified.");
  const profile = (await response.json()) as { emailAddress?: string };
  if (!profile.emailAddress) throw new ProviderRequestError(401, "A verified Google email is required.");
  // OpenID claims are optional. A mailbox token that also consented to userinfo can supply them;
  // a userinfo failure must not invalidate a Gmail grant this profile call already proved.
  const identity = await openIdClaims(input, { fetcher, signal });
  return {
    accountId: profile.emailAddress.toLowerCase(),
    displayName: profile.emailAddress,
    ...identity,
    grantedScopes,
  };
}

async function openIdClaims(
  input: Extract<ResolvedCredential, { authType: "oauth2" }>,
  options: CredentialValidatorOptions,
): Promise<Pick<CredentialProfileInput, "googleSubject" | "hostedDomain" | "emailVerified">> {
  try {
    const profile = await openIdProfile(input, options, []);
    return {
      googleSubject: profile.googleSubject,
      hostedDomain: profile.hostedDomain,
      emailVerified: profile.emailVerified,
    };
  } catch {
    return {};
  }
}

function grantedScopeList(input: Extract<ResolvedCredential, { authType: "oauth2" }>): string[] {
  return typeof input.metadata.scope === "string" ? input.metadata.scope.split(/\s+/).filter(Boolean) : [];
}
