import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./executors.ts";

function contextWithKey(apiKey?: string): ExecutionContext {
  const credential: ResolvedCredential = apiKey
    ? {
        authType: "api_key",
        apiKey,
        values: { apiKey },
        profile: { accountId: "api_key", displayName: "FXMacroData API Key", grantedScopes: [] },
        metadata: {},
      }
    : { authType: "no_auth" };
  return { getCredential: async () => credential };
}

/** Upstream that echoes whatever key it was sent back in its error body. */
function echoingUpstream(): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const key = new Headers(init?.headers).get("x-api-key") ?? "none";
    return Response.json({ detail: `Key ${key} is not active.`, key }, { status: 403 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FXMacroData proxy", () => {
  it("removes the stored key from an upstream error message and details", async () => {
    echoingUpstream();

    const result = await proxy({ method: "GET", endpoint: "/v1/cot/eur" }, contextWithKey("proxy-key-123"));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("proxy-key-123");
    expect(JSON.stringify(result)).toContain("Key [REDACTED] is not active.");
  });

  it("keeps each concurrent request's key separate", async () => {
    const fetch = echoingUpstream();

    const results = await Promise.all([
      proxy({ method: "GET", endpoint: "/v1/cot/eur" }, contextWithKey("first-key-aaa")),
      proxy({ method: "GET", endpoint: "/v1/cot/gbp" }, contextWithKey("second-key-bbb")),
    ]);

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const result of results) {
      expect(JSON.stringify(result)).not.toMatch(/first-key-aaa|second-key-bbb/);
    }
  });

  it("sends no key header and leaves keyless errors unchanged", async () => {
    const fetch = echoingUpstream();

    const result = await proxy({ method: "GET", endpoint: "/v1/cot/eur" }, contextWithKey());

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBeNull();
    expect(JSON.stringify(result)).toContain("Key none is not active.");
  });
});
