import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { provider as githubProvider } from "../../providers/github/definition.ts";
import { ProviderLoader } from "../../providers/provider-loader.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { PlainTextSecretCodec } from "../secrets/secret-codec-core.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup(runtimeToken = "runtime-token") {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  const { app } = await createConnectApp({
    catalog: createCatalogStore([githubProvider]),
    runtimeDatabase: database,
    providerLoader: new ProviderLoader({}),
    transitFiles: new TransitFileService({
      rootDir: ".tmp/user-connection-tests",
      publicOrigin: "http://localhost",
      ttlSeconds: 60,
      maxBytes: 1024,
    }),
    publicOrigin: "http://localhost",
    secretCodec: new PlainTextSecretCodec(),
    runtimeToken,
  });
  return app;
}

function headers(userId?: string, token = "runtime-token"): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(userId ? { "x-arbis-user-id": userId } : {}),
  };
}

describe("user connector routes", () => {
  it("stores and lists mappings for the header user only", async () => {
    const app = await setup();
    const created = await app.request("/v1/users/connectors", {
      method: "POST",
      headers: headers("user-a"),
      body: JSON.stringify({ connectionService: "gmail" }),
    });
    expect(created.status).toBe(200);
    const mapping = (await created.json()).data;
    expect(mapping).toMatchObject({ userId: "user-a", connectionService: "gmail" });

    const again = await app.request("/v1/users/connectors", {
      method: "POST",
      headers: headers("user-a"),
      body: JSON.stringify({ userId: "user-a", connectionService: "gmail" }),
    });
    expect((await again.json()).data.id).toBe(mapping.id);

    await app.request("/v1/users/connectors", {
      method: "POST",
      headers: headers("user-b"),
      body: JSON.stringify({ connectionService: "github" }),
    });

    const listed = await app.request("/v1/users/connectors", { headers: headers("user-a") });
    expect((await listed.json()).data).toEqual([
      expect.objectContaining({ userId: "user-a", connectionService: "gmail" }),
    ]);
  });

  it("rejects a body or query userId that does not match the header", async () => {
    const app = await setup();
    const created = await app.request("/v1/users/connectors", {
      method: "POST",
      headers: headers("user-a"),
      body: JSON.stringify({ userId: "user-b", connectionService: "gmail" }),
    });
    expect(created.status).toBe(403);
    expect((await created.json()).errorCode).toBe("forbidden");

    const listed = await app.request("/v1/users/connectors?userId=user-b", { headers: headers("user-a") });
    expect(listed.status).toBe(403);
  });

  it("requires the Arbis user header and the runtime token", async () => {
    const app = await setup();
    const missingUser = await app.request("/v1/users/connectors", { headers: headers() });
    expect(missingUser.status).toBe(400);

    const missingToken = await app.request("/v1/users/connectors", {
      headers: { "x-arbis-user-id": "user-a" },
    });
    expect(missingToken.status).toBe(401);
  });

  it("deletes only a mapping owned by the header user", async () => {
    const app = await setup();
    const created = await app.request("/v1/users/connectors", {
      method: "POST",
      headers: headers("user-a"),
      body: JSON.stringify({ connectionService: "gmail" }),
    });
    const id = (await created.json()).data.id as string;

    const foreign = await app.request(`/v1/users/connectors/${id}`, {
      method: "DELETE",
      headers: headers("user-b"),
    });
    expect(foreign.status).toBe(404);

    const removed = await app.request(`/v1/users/connectors/${id}`, {
      method: "DELETE",
      headers: headers("user-a"),
    });
    expect(removed.status).toBe(200);

    const listed = await app.request("/v1/users/connectors", { headers: headers("user-a") });
    expect((await listed.json()).data).toEqual([]);
  });
});
