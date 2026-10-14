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
      credential: { authType: "oauth2", profile: { accountId, grantedScopes: scopes } },
    }),
    getManagedConnectionByAlias: vi.fn().mockRejectedValue(new ConnectionError("connection_not_found", "missing")),
    setOAuthCredential: vi.fn().mockResolvedValue({ id: "child" }),
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
    expect(connections.setOAuthCredential).not.toHaveBeenCalled();
    expect(
      await materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "me@acme.test"),
    ).toEqual({ id: "child" });
  });
  it("rejects the wrong account and unrelated services", async () => {
    const connections = service();
    await expect(
      materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "other@acme.test"),
    ).rejects.toThrow("does not match");
    await expect(
      materializeGoogleAccount(connections as unknown as ConnectionService, "root", "googledrive", "me@acme.test"),
    ).rejects.toThrow("Only email");
    expect(connections.setOAuthCredential).not.toHaveBeenCalled();
  });
  it("returns an existing child on retry without overwriting its credential", async () => {
    const connections = service();
    connections.getManagedConnectionByAlias.mockResolvedValue({ id: "existing" });
    expect(
      await materializeGoogleAccount(connections as unknown as ConnectionService, "root", "gmail", "me@acme.test"),
    ).toEqual({ id: "existing" });
    expect(connections.setOAuthCredential).not.toHaveBeenCalled();
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
          .mockResolvedValue(new Response(JSON.stringify({ email: "me@acme.test", email_verified: true }))),
        signal: undefined,
      },
    );
    expect(result?.profile?.grantedScopes).toEqual(["openid", "email"]);
  });
});
