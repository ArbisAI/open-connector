import type { ProviderHttpAttempt } from "../../core/provider-http-dispatch.ts";

import { Hono } from "hono";
import { afterEach, describe, it, expect, vi } from "vitest";
import { companyAuthorizationMiddleware, companyDispatchOptions } from "./company-authorization.ts";
const attempt: ProviderHttpAttempt = {
  attemptId: "one",
  requestId: "one",
  redirectHop: 0,
  method: "GET",
  origin: "https://gmail.googleapis.com",
  authority: {},
  context: { operation: "action", service: "gmail", actionId: "gmail.list", connectionId: "owned" },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("company execution authority", () => {
  it("denies a service-token-only call before provider access", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await companyDispatchOptions()!.beforeAttempt(attempt, undefined)).toEqual({ allow: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rechecks every hop and denies revoked or foreign connections", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ connection_id: "owned", service: "gmail" }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ connection_id: "other", service: "gmail" }));
    vi.stubGlobal("fetch", fetch);
    const hook = companyDispatchOptions()!;
    const app = new Hono();
    app.use("*", companyAuthorizationMiddleware());
    app.get("/", async (c) => c.json(await hook.beforeAttempt(attempt, undefined)));
    const call = () =>
      app.request("http://test/", {
        headers: { "X-Nexo-Authorization": "employee-grant", "X-Nexo-Operation": "operation-1" },
      });
    expect(await (await call()).json()).toEqual({ allow: true });
    expect(await (await call()).json()).toEqual({ allow: false });
    expect(await (await call()).json()).toEqual({ allow: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ actionId: "gmail.list", operationId: "operation-1" });
  });
  it("does not mistake unavailable authorization for permission", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const app = new Hono();
    app.use("*", companyAuthorizationMiddleware());
    app.get("/", async (c) => c.json(await companyDispatchOptions()!.beforeAttempt(attempt, undefined)));
    const response = await app.request("http://test/", {
      headers: { "X-Nexo-Authorization": "grant", "X-Nexo-Operation": "operation-1" },
    });
    expect(await response.json()).toEqual({ allow: false, retryAfterSeconds: 2 });
  });
});
