import type { ConnectionService } from "../connection-service.ts";

import { describe, it, expect, vi } from "vitest";
import { ConnectionError } from "../connection-service.ts";
import { provider } from "../providers/googleworkspace/definition.ts";
import { credentialValidators } from "../providers/googleworkspace/executors.ts";
import { materializeGoogleAccount } from "./google-workspace.ts";
const scope = "https://www.googleapis.com/auth/gmail.readonly";
function service(scopes = [scope], accountId = "me@acme.test") {
  return {
    getStoredConnection: vi.fn().mockResolvedValue({
      id: "root",
      service: "googleworkspace",
      credential: {
        authType: "oauth2",
        profile: { accountId, grantedScopes: scopes, googleSubject: "google-1", emailVerified: true },
      },
    }),
    getManagedConnectionByAlias: vi.fn().mockRejectedValue(new ConnectionError("connection_not_found", "missing")),
    prepareOAuthCredential: vi.fn(async (_service: string, credential: { profile: { accountId: string } }) => ({
      ...credential,
      profile: { ...credential.profile, googleSubject: "google-1", emailVerified: true },
    })),
    savePreparedOAuthCredential: vi.fn().mockResolvedValue({ id: "child" }),
    getManagedConnection: vi.fn().mockResolvedValue({ id: "child" }),
  };
}
describe("Google combined consent", () => {
  it("declares only identity, email and calendar scopes", () => {
    const auth = provider.auth[0];
    expect(auth.type).toBe("oauth2");
    if (auth.type !== "oauth2") throw new Error("oauth");
    expect(
      auth.scopes.every(
        (s) =>
          ["openid", "email", "profile"].includes(s) || s.includes("/auth/gmail.") || s.includes("/auth/calendar."),
      ),
    ).toBe(true);
    expect(auth.authorizationOptions?.filter((o) => o.defaultSelected).map((o) => o.id)).not.toContain(
      "https://www.googleapis.com/auth/gmail.send",
    );
  });
  it("materializes only explicitly granted services", async () => {
    const connections = service();
    expect(
      await materializeGoogleAccount(
        connections as unknown as ConnectionService,
        "root",
        "googlecalendar",
        "me@acme.test",
      ),
    ).toBeNull();
    expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
    expect(
      await materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "me@acme.test"),
    ).toEqual({ id: "child" });
  });

  it("materializes the calendar account from a least-privilege freebusy grant", async () => {
    const connections = service(["https://www.googleapis.com/auth/calendar.events.freebusy"]);
    expect(
      await materializeGoogleAccount(
        connections as unknown as ConnectionService,
        "root",
        "googlecalendar",
        "me@acme.test",
      ),
    ).toEqual({ id: "child" });
    expect(
      await materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "me@acme.test"),
    ).toBeNull();
  });

  it("offers the scopes a least-privilege Nexo consent requests", () => {
    const auth = provider.auth[0];
    if (auth.type !== "oauth2") throw new Error("oauth");
    const ids = auth.authorizationOptions?.map((option) => option.id) ?? [];
    for (const required of [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    ]) {
      expect(ids).toContain(required);
    }
  });
  it("rejects the wrong account and unrelated services", async () => {
    const connections = service();
    await expect(
      materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "other@acme.test"),
    ).rejects.toThrow("does not match");
    await expect(
      materializeGoogleAccount(connections as unknown as ConnectionService, "root", "googledrive", "me@acme.test"),
    ).rejects.toThrow("Only email");
    expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
  });
  it("returns an existing child on retry without overwriting its credential", async () => {
    const connections = service();
    connections.getManagedConnectionByAlias.mockResolvedValue({ id: "existing" });
    expect(
      await materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "me@acme.test"),
    ).toEqual({ id: "existing" });
    expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
  });
  it("uses returned scopes, never requested scopes, after partial consent", async () => {
    const result = await credentialValidators.oauth2!(
      {
        authType: "oauth2",
        accessToken: "token",
        tokenType: "Bearer",
        profile: { accountId: "oauth2", displayName: "", grantedScopes: [scope] },
        metadata: { scope: "openid email" },
      },
      {
        fetcher: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ email: "me@acme.test", email_verified: true, sub: "google-1" })),
          ),
        signal: undefined,
      },
    );
    expect(result?.profile?.grantedScopes).toEqual(["openid", "email"]);
  });
});
