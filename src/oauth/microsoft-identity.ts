import type { JWTVerifyGetKey } from "jose";

import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import { providerFetch } from "../providers/provider-runtime.ts";

const keys = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"), {
  [customFetch]: providerFetch,
});
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MicrosoftIdentity {
  tenantId: string;
  objectId: string;
}

/** Identifies the providers that share Microsoft's organizational OAuth lifecycle. */
export function isMicrosoftService(service: string): boolean {
  return ["microsoft365", "outlook", "outlook_calendar"].includes(service);
}

/** Verify the app audience, organizational issuer, signature, lifetime, and request nonce. */
export async function verifyMicrosoftIdentity(
  token: string | undefined,
  clientId: string,
  nonce: string | undefined,
  resolver: JWTVerifyGetKey = keys,
): Promise<MicrosoftIdentity> {
  if (!token) throw new Error("Microsoft did not return a verifiable account identity.");
  const { tid } = decodeJwt(token);
  if (typeof tid !== "string" || !guid.test(tid) || tid.toLowerCase() === "9188040d-6c67-4c5b-b112-36a304b66dad")
    throw new Error("Connect a Microsoft work or school account.");
  const { payload } = await jwtVerify(token, resolver, {
    algorithms: ["RS256"],
    audience: clientId,
    issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
    requiredClaims: nonce ? ["exp", "iat", "nonce", "oid", "tid"] : ["exp", "iat", "oid", "tid"],
  });
  if ((nonce !== undefined && payload.nonce !== nonce) || typeof payload.oid !== "string" || !guid.test(payload.oid))
    throw new Error("Microsoft account identity did not match this connection request.");
  return { tenantId: tid.toLowerCase(), objectId: payload.oid.toLowerCase() };
}
