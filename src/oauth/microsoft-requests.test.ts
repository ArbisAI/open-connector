import { describe, expect, it } from "vitest";
import { SqliteRuntimeDatabase } from "../server/storage/sqlite/runtime-store.ts";

function request(id: string, service = "microsoft365") {
  return {
    service,
    connectionName: id,
    state: `state-${id}`,
    connectionRequestId: id,
    owner: "local-admin",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
}
describe("Microsoft consent request isolation", () => {
  it("preserves concurrent users behind the same backend administrator bearer", async () => {
    const db = new SqliteRuntimeDatabase(":memory:");
    try {
      await db.connectionRequestStore.create(request("member-a"));
      await db.connectionRequestStore.create(request("member-b"));
      expect((await db.connectionRequestStore.get("member-a", "local-admin"))?.status).toBe("initiated");
      expect((await db.connectionRequestStore.get("member-b", "local-admin"))?.status).toBe("initiated");
      const first = await db.connectionRequestStore.claim("state-member-a");
      expect(first?.connectionRequestId).toBe("member-a");
      expect(await db.connectionRequestStore.claim("state-member-a")).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("preserves existing supersession behavior for other providers", async () => {
    const db = new SqliteRuntimeDatabase(":memory:");
    try {
      await db.connectionRequestStore.create(request("first", "example"));
      await db.connectionRequestStore.create(request("second", "example"));
      expect((await db.connectionRequestStore.get("first", "local-admin"))?.status).toBe("failed");
      expect((await db.connectionRequestStore.get("second", "local-admin"))?.status).toBe("initiated");
    } finally {
      db.close();
    }
  });
});
