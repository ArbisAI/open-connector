import type { OAuthClientConfig, IOAuthClientConfigStore } from "./oauth-client-config-service.ts";

import { describe, expect, it } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { provider as broker } from "../providers/microsoft365/definition.ts";
import { provider as mail } from "../providers/outlook/definition.ts";
import { provider as calendar } from "../providers/outlook_calendar/definition.ts";
import { OAuthClientConfigService } from "./oauth-client-config-service.ts";

async function configured() {
  const values = new Map<string, OAuthClientConfig>();
  const store: IOAuthClientConfigStore = {
    get: async (service) => values.get(service),
    set: async (config) => {
      values.set(config.service, config);
    },
    delete: async (service) => {
      values.delete(service);
    },
    list: async () => [...values.values()],
  };
  const configs = new OAuthClientConfigService({
    catalog: createCatalogStore([mail, calendar, broker]),
    origin: "https://railway.example",
    store,
  });
  for (const service of ["outlook", "outlook_calendar"])
    await configs.upsertConfig({
      service,
      clientId: "nexo",
      clientSecret: "secret",
      extra: { tenant: "organizations" },
      requestedScopes:
        service === "outlook"
          ? ["User.Read", "Mail.ReadWrite", "Mail.Send", "offline_access"]
          : ["User.Read", "Calendars.ReadWrite", "offline_access"],
    });
  return { configs, values };
}
describe("Microsoft broker application setup", () => {
  it("defaults new broker apps to both organizational and personal accounts", () => {
    expect(
      broker.auth[0].type === "oauth2" &&
        broker.auth[0].clientConfigFields?.find((field) => field.key === "tenant")?.defaultValue,
    ).toBe("common");
  });
  it("reuses the existing app without creating another stored configuration", async () => {
    const { configs, values } = await configured();
    const config = await configs.getConfig("microsoft365");
    expect(config?.extra.tenant).toBe("organizations");
    expect(config?.requestedScopes).toContain("openid");
    expect(config?.requestedScopes).not.toContain("MailboxSettings.ReadWrite");
    expect(await configs.getSummary("microsoft365")).toMatchObject({
      configured: true,
      expectedRedirectUri: "https://railway.example/oauth/callback",
    });
    expect((await configs.listConfigs()).find((item) => item.service === "microsoft365")?.configured).toBe(true);
    expect(values.size).toBe(2);
  });
  it("refuses to combine different Microsoft applications", async () => {
    const { configs, values } = await configured();
    values.set("outlook_calendar", { ...values.get("outlook_calendar")!, clientId: "different" });
    expect(await configs.getConfig("microsoft365")).toBeUndefined();
  });
  it("preserves a common authority when reusing the Microsoft app", async () => {
    const { configs, values } = await configured();
    for (const service of ["outlook", "outlook_calendar"])
      values.set(service, { ...values.get(service)!, extra: { tenant: "common" } });
    expect((await configs.getConfig("microsoft365"))?.extra.tenant).toBe("common");
  });
});
