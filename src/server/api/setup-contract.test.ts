import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { provider as notion } from "../../providers/notion/definition.ts";
import { provider as stripe } from "../../providers/stripe/definition.ts";
import { serializeRuntimeProviderSetup } from "./runtime-api.ts";

describe("application connection setup", () => {
  it("advertises both methods without exposing OAuth client configuration fields", () => {
    const provider = createCatalogStore([notion]).providers[0];
    const setup = serializeRuntimeProviderSetup(provider, {
      configured: false,
      customClientAvailable: true,
      expectedRedirectUri: "https://connector.example/oauth/callback",
      missingFields: ["clientId"],
    });
    expect(setup.authMethods).toEqual([
      expect.objectContaining({ type: "oauth", configured: false, fields: [] }),
      expect.objectContaining({
        type: "api_key",
        configured: true,
        fields: [expect.objectContaining({ key: "apiKey", secret: true, required: true })],
      }),
    ]);
    expect(JSON.stringify(setup.authMethods)).not.toContain("clientSecret");
    expect(JSON.stringify(setup.authMethods)).not.toContain("authorizationUrl");
  });

  it("reflects configured OAuth and describes an API-key-only provider", () => {
    const providers = createCatalogStore([notion, stripe]).providers;
    const oauth = serializeRuntimeProviderSetup(providers[0], {
      configured: true,
      customClientAvailable: false,
      expectedRedirectUri: "https://connector.example/oauth/callback",
      missingFields: [],
    });
    expect(oauth.authMethods.find((method) => method.type === "oauth")?.configured).toBe(true);
    const setup = serializeRuntimeProviderSetup(providers[1]);
    expect(setup.authMethods).toHaveLength(1);
    expect(setup.authMethods[0]).toMatchObject({ type: "api_key", configured: true });
  });
});
