import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { microsoftPersonalTenant, verifyMicrosoftIdentity } from "./microsoft-identity.ts";
import { microsoftProfile } from "./microsoft-profile.ts";

const tenant = "11111111-1111-1111-1111-111111111111";
const person = "22222222-2222-2222-2222-222222222222";
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  pair = await generateKeyPair("RS256");
});
async function token(changes: { tid?: string; oid?: string; nonce?: string } = {}, issuerTenant = tenant) {
  return new SignJWT({ tid: tenant, oid: person, nonce: "bound", ...changes })
    .setProtectedHeader({ alg: "RS256" })
    .setAudience("nexo")
    .setIssuer(`https://login.microsoftonline.com/${issuerTenant}/v2.0`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
}
describe("Microsoft account identity", () => {
  it("verifies the signed organizational identity", async () => {
    expect(await verifyMicrosoftIdentity(await token(), "nexo", "bound", async () => pair.publicKey)).toEqual({
      tenantId: tenant,
      objectId: person,
    });
  });
  it.each([{ nonce: "wrong" }, { tid: "other" }, { oid: "bad" }, { tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }])(
    "rejects invalid claims %j",
    async (claims) => {
      await expect(
        verifyMicrosoftIdentity(await token(claims), "nexo", "bound", async () => pair.publicKey),
      ).rejects.toThrow();
    },
  );
  it("rejects another application and an expired token", async () => {
    await expect(
      verifyMicrosoftIdentity(await token(), "other", "bound", async () => pair.publicKey),
    ).rejects.toThrow();
    const expired = await new SignJWT({ tid: tenant, oid: person, nonce: "bound" })
      .setProtectedHeader({ alg: "RS256" })
      .setAudience("nexo")
      .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
      .setIssuedAt()
      .setExpirationTime(1)
      .sign(pair.privateKey);
    await expect(verifyMicrosoftIdentity(expired, "nexo", "bound", async () => pair.publicKey)).rejects.toThrow();
  });
  it("rejects a different signature and a missing identity token", async () => {
    const other = await generateKeyPair("RS256");
    await expect(
      verifyMicrosoftIdentity(await token(), "nexo", "bound", async () => other.publicKey),
    ).rejects.toThrow();
    await expect(verifyMicrosoftIdentity(undefined, "nexo", "bound")).rejects.toThrow();
  });
  it("uses Graph identity and actual granted scopes, never a mailbox label as the stable ID", async () => {
    const credential = {
      authType: "oauth2" as const,
      accessToken: "secret",
      tokenType: "Bearer",
      profile: { accountId: "oauth2", displayName: "", grantedScopes: [] },
      metadata: {
        microsoftIdentity: { tenantId: tenant, objectId: person },
        scope: "User.Read https://graph.microsoft.com/Mail.ReadWrite",
      },
    };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        id: person,
        mail: "mail@acme.test",
        userPrincipalName: "person@acme.test",
        userType: "Member",
      }),
    );
    const profile = await microsoftProfile(credential, { fetcher });
    expect(profile).toMatchObject({
      accountId: person,
      microsoftTenantId: tenant,
      microsoftPrincipalName: "person@acme.test",
      grantedScopes: ["User.Read", "Mail.ReadWrite"],
    });
    fetcher.mockResolvedValue(Response.json({ id: tenant }));
    await expect(microsoftProfile(credential, { fetcher })).rejects.toThrow("do not match");
  });
  it("verifies personal identity only under Microsoft's matching signed consumer issuer", async () => {
    const claims = { tid: microsoftPersonalTenant, oid: "00000000-0000-0000-0123-456789abcdef" };
    expect(
      await verifyMicrosoftIdentity(
        await token(claims, microsoftPersonalTenant),
        "nexo",
        "bound",
        async () => pair.publicKey,
      ),
    ).toEqual({ tenantId: microsoftPersonalTenant, objectId: claims.oid });
    await expect(
      verifyMicrosoftIdentity(await token(claims), "nexo", "bound", async () => pair.publicKey),
    ).rejects.toThrow();
    await expect(
      verifyMicrosoftIdentity(
        await token({ ...claims, nonce: "unbound" }, microsoftPersonalTenant),
        "nexo",
        "bound",
        async () => pair.publicKey,
      ),
    ).rejects.toThrow();
  });
  it("binds a personal Graph CID to the signed oid and uses the mailbox address without requiring userType", async () => {
    const credential = {
      authType: "oauth2" as const,
      accessToken: "personal-access",
      tokenType: "Bearer",
      profile: { accountId: "oauth2", displayName: "", grantedScopes: [] },
      metadata: {
        microsoftIdentity: { tenantId: microsoftPersonalTenant, objectId: "00000000-0000-0000-0123-456789abcdef" },
        scope: "User.Read Mail.ReadWrite Calendars.ReadWrite",
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ id: "0123456789ABCDEF", mail: "person@outlook.com", userPrincipalName: "alias@outlook.com" }),
      );
    expect(await microsoftProfile(credential, { fetcher })).toMatchObject({
      accountId: "0123456789ABCDEF",
      microsoftPrincipalName: "person@outlook.com",
      microsoftTenantId: microsoftPersonalTenant,
    });
    fetcher.mockResolvedValue(Response.json({ id: "1123456789abcdef", mail: "person@outlook.com" }));
    await expect(microsoftProfile(credential, { fetcher })).rejects.toThrow("do not match");
    credential.metadata.microsoftIdentity.tenantId = tenant;
    fetcher.mockResolvedValue(Response.json({ id: "0123456789abcdef" }));
    await expect(microsoftProfile(credential, { fetcher })).rejects.toThrow("do not match");
  });
});
