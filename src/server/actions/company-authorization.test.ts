import type { ProviderHttpAttempt } from "../../core/provider-http-dispatch.ts";

import { Hono } from "hono";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  authorizeCompanyExecution,
  companyAuthorizationMiddleware,
  companyDispatchOptions,
} from "./company-authorization.ts";

const attempt: ProviderHttpAttempt = {
  attemptId: "one",
  requestId: "one",
  redirectHop: 0,
  method: "GET",
  origin: "https://gmail.googleapis.com",
  authority: {},
  context: { operation: "action", service: "gmail", actionId: "gmail.list", connectionId: "owned" },
};
const proxyAttempt: ProviderHttpAttempt = {
  ...attempt,
  context: { operation: "proxy", service: "gmail", connectionId: "owned" },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function authorizedApp(hook: NonNullable<ReturnType<typeof companyDispatchOptions>>) {
  const app = new Hono();
  app.use("*", companyAuthorizationMiddleware());
  app.get("/", async (c) => c.json(await hook.beforeAttempt(attempt, undefined)));
  return app;
}

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
      .mockImplementationOnce(() => Response.json({ connection_id: "owned", service: "gmail" }))
      .mockImplementationOnce(() => new Response(null, { status: 403 }))
      .mockImplementationOnce(() => Response.json({ connection_id: "other", service: "gmail" }));
    vi.stubGlobal("fetch", fetch);
    const hook = companyDispatchOptions()!;
    const call = () =>
      authorizedApp(hook).request("http://test/", {
        headers: { "X-Nexo-Authorization": "employee-grant", "X-Nexo-Operation": "operation-1" },
      });
    expect(await (await call()).json()).toEqual({ allow: true });
    expect(await (await call()).json()).toEqual({ allow: false });
    expect(await (await call()).json()).toEqual({ allow: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      actionId: "gmail.list",
      operationId: "operation-1",
      connectionId: "owned",
      service: "gmail",
    });
    expect(fetch.mock.calls[0][1].redirect).toBe("manual");
  });

  it("authorizes a proxy hop without an action id", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    const fetch = vi.fn().mockResolvedValue(Response.json({ connection_id: "owned", service: "gmail" }));
    vi.stubGlobal("fetch", fetch);
    const hook = companyDispatchOptions()!;
    const app = new Hono();
    app.use("*", companyAuthorizationMiddleware());
    app.get("/", async (c) => c.json(await hook.beforeAttempt(proxyAttempt, undefined)));
    expect(
      await (
        await app.request("http://test/", {
          headers: { "X-Nexo-Authorization": "employee-grant", "X-Nexo-Operation": "operation-1" },
        })
      ).json(),
    ).toEqual({ allow: true });
    expect(JSON.parse(fetch.mock.calls[0][1].body).actionId).toBeUndefined();
  });

  it("accepts the same loopback endpoint for prepare and provider hops", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "http://127.0.0.1:8000/authorize");
    const fetch = vi.fn().mockImplementation(() => Response.json({ connection_id: "owned", service: "gmail" }));
    vi.stubGlobal("fetch", fetch);
    const hook = companyDispatchOptions()!;
    const app = new Hono();
    app.use("*", companyAuthorizationMiddleware());
    app.get("/", async (c) =>
      c.json({
        hop: await hook.beforeAttempt(attempt, undefined),
        prepare: await authorizeCompanyExecution({
          operation: "action",
          service: "gmail",
          connectionId: "owned",
          actionId: "gmail.list",
        }),
      }),
    );
    expect(
      await (
        await app.request("http://test/", {
          headers: { "X-Nexo-Authorization": "grant", "X-Nexo-Operation": "operation-1" },
        })
      ).json(),
    ).toEqual({ hop: { allow: true }, prepare: { ok: true } });
  });

  it("does not mistake unavailable authorization for permission", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const hook = companyDispatchOptions()!;
    const app = new Hono();
    app.use("*", companyAuthorizationMiddleware());
    app.get("/", async (c) =>
      c.json({
        hop: await hook.beforeAttempt(attempt, undefined),
        prepare: await authorizeCompanyExecution({
          operation: "action",
          service: "gmail",
          connectionId: "owned",
          actionId: "gmail.list",
        }),
      }),
    );
    expect(
      await (
        await app.request("http://test/", {
          headers: { "X-Nexo-Authorization": "grant", "X-Nexo-Operation": "operation-1" },
        })
      ).json(),
    ).toEqual({
      hop: { allow: false, retryAfterSeconds: 2 },
      prepare: { ok: false, reason: "unavailable", retryAfterSeconds: 2 },
    });
  });

  it("rejects a redirect instead of trusting another host", async () => {
    vi.stubEnv("COMPANY_ONBOARDING_ENABLED", "true");
    vi.stubEnv("COMPANY_AUTHORIZATION_URL", "https://core.test/authorize");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.test" } })),
    );
    const hook = companyDispatchOptions()!;
    expect(
      await (
        await authorizedApp(hook).request("http://test/", {
          headers: { "X-Nexo-Authorization": "grant", "X-Nexo-Operation": "operation-1" },
        })
      ).json(),
    ).toEqual({ allow: false });
  });
});
