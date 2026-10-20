import type { ConnectionService } from "../connection-service.ts";

import { describe, it, expect, vi } from "vitest";
import { ConnectionError } from "../connection-service.ts";
import { provider } from "../providers/microsoft365/definition.ts";
import { materializeMicrosoftAccount } from "./microsoft-workspace.ts";

function fixture(scopes = ["User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"]) {
  const profile = {
    accountId: "person",
    microsoftTenantId: "tenant",
    microsoftObjectId: "person",
    grantedScopes: scopes,
  };
  return {
    getStoredConnection: vi
      .fn()
      .mockResolvedValue({ id: "root", service: "microsoft365", credential: { authType: "oauth2", profile } }),
    getManagedConnectionByAlias: vi.fn().mockRejectedValue(new ConnectionError("connection_not_found", "missing")),
    prepareOAuthCredential: vi.fn(async (_service: string, credential: object) => credential),
    savePreparedOAuthCredential: vi.fn().mockResolvedValue({ id: "child" }),
    getManagedConnection: vi.fn().mockResolvedValue({ id: "child" }),
  };
}
describe("Microsoft combined consent", () => {
  it("excludes mailbox settings and shared calendars", () => {
    const auth = provider.auth[0];
    expect(auth.type === "oauth2" && auth.scopes).toEqual([
      "openid",
      "profile",
      "User.Read",
      "offline_access",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
    ]);
  });
  it.each(["outlook", "outlook_calendar"])("creates %s from the same identity", async (service) => {
    const connections = fixture();
    await expect(
      materializeMicrosoftAccount(
        connections as unknown as ConnectionService,
        "root",
        service,
        "microsoft:tenant:person",
        async () => Response.json({ value: [] }),
      ),
    ).resolves.toEqual({ id: "child" });
    expect(connections.savePreparedOAuthCredential).toHaveBeenCalledOnce();
  });
  it.each(["outlook", "outlook_calendar"])("rejects missing permissions for %s", async (service) => {
    const connections = fixture(["User.Read"]);
    await expect(
      materializeMicrosoftAccount(
        connections as unknown as ConnectionService,
        "root",
        service,
        "microsoft:tenant:person",
        async () => Response.json({ value: [] }),
      ),
    ).rejects.toThrow("permissions");
    expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
  });
  it("rejects a different identity", async () => {
    const connections = fixture();
    await expect(
      materializeMicrosoftAccount(connections as unknown as ConnectionService, "root", "outlook", "other"),
    ).rejects.toThrow("does not match");
  });
  it("retries without replacing the existing child credential", async () => {
    const connections = fixture();
    connections.getManagedConnectionByAlias.mockResolvedValue({ id: "existing" });
    expect(
      await materializeMicrosoftAccount(
        connections as unknown as ConnectionService,
        "root",
        "outlook",
        "microsoft:tenant:person",
        async () => Response.json({ value: [] }),
      ),
    ).toEqual({ id: "existing" });
    expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
  });
});

it("rejects an unlicensed or forbidden mailbox before saving a child", async () => {
  const connections = fixture();
  await expect(
    materializeMicrosoftAccount(
      connections as unknown as ConnectionService,
      "root",
      "outlook",
      "microsoft:tenant:person",
      async () => new Response(null, { status: 403 }),
    ),
  ).rejects.toMatchObject({ code: "microsoft_mailbox_unavailable" });
  expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
});
it("keeps a temporary mailbox failure retryable", async () => {
  const connections = fixture();
  await expect(
    materializeMicrosoftAccount(
      connections as unknown as ConnectionService,
      "root",
      "outlook",
      "microsoft:tenant:person",
      async () => new Response(null, { status: 503 }),
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(connections.savePreparedOAuthCredential).not.toHaveBeenCalled();
});
