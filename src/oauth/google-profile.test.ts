import type { ResolvedCredential } from "../core/types.ts";

import { describe, it, expect } from "vitest";
import { googleProfile } from "./google-profile.ts";
const credential = {
  authType: "oauth2",
  accessToken: "private",
  tokenType: "Bearer",
  profile: { accountId: "employee@acme.test", displayName: "Employee", grantedScopes: [] },
  metadata: { scope: "openid email https://www.googleapis.com/auth/gmail.readonly" },
} as Extract<ResolvedCredential, { authType: "oauth2" }>;
describe("Google ownership evidence", () => {
  it("retains verified subject and hosted domain without reading Google work content", async () => {
    const calls: string[] = [];
    const profile = await googleProfile(credential, {
      fetcher: async (input) => {
        calls.push(String(input));
        return Response.json({ sub: "google-123", email: "Employee@Acme.test", email_verified: true, hd: "acme.test" });
      },
    });
    expect(profile).toMatchObject({
      accountId: "employee@acme.test",
      googleSubject: "google-123",
      hostedDomain: "acme.test",
      emailVerified: true,
    });
    expect(calls).toEqual(["https://openidconnect.googleapis.com/v1/userinfo"]);
  });
  it.each([
    { email: "employee@acme.test", email_verified: true },
    { sub: "123", email: "employee@acme.test", email_verified: false },
  ])("rejects incomplete identity evidence", async (profile) => {
    await expect(googleProfile(credential, { fetcher: async () => Response.json(profile) })).rejects.toThrow(
      "verified Google email",
    );
  });
});
