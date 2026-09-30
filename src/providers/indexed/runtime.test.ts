import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { indexedActionHandlers, validateIndexedCredential } from "./runtime.ts";

function contextFor(handler: (url: URL, init: RequestInit | undefined) => Response) {
  return {
    apiKey: "idx_test",
    fetcher: (async (url: URL | string, init?: RequestInit) => handler(new URL(url), init)) as typeof fetch,
  };
}

describe("Indexed runtime", () => {
  it("sends the key in X-API-Key and joins list filters with commas", async () => {
    let seen: { url: URL; headers: Headers } | undefined;
    const context = contextFor((url, init) => {
      seen = { url, headers: new Headers(init?.headers) };
      return Response.json({ data: [], meta: { total: 0 } });
    });

    await indexedActionHandlers.search_companies!(
      { q: "payments", industries: ["Fintech", "ai-ml"], minFunding: 1000000, limit: 10 },
      context,
    );

    expect(seen?.headers.get("x-api-key")).toBe("idx_test");
    expect(seen?.headers.get("authorization")).toBeNull();
    expect(seen?.url.pathname).toBe("/api/v1/companies");
    expect(seen?.url.searchParams.get("industries")).toBe("Fintech,ai-ml");
    expect(seen?.url.searchParams.get("minFunding")).toBe("1000000");
    expect(seen?.url.searchParams.has("countries")).toBe(false);
  });

  it("reports exhausted credits as insufficient_credit", async () => {
    const context = contextFor(() =>
      Response.json({ error: "Credits exhausted", code: "CREDIT_LIMIT_REACHED" }, { status: 402 }),
    );

    const error = await indexedActionHandlers.get_company!({ slug: "stripe", depth: "full" }, context).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderRequestError);
    expect(error).toMatchObject({ status: 402, code: "insufficient_credit" });
  });

  it("keeps a plan-tier refusal separate from a credential failure and preserves a not-found status", async () => {
    const tier = contextFor(() =>
      Response.json({ error: "Upgrade required", code: "TIER_UPGRADE_REQUIRED" }, { status: 403 }),
    );
    const badKey = contextFor(() => Response.json({ error: "Invalid API key", code: "UNAUTHORIZED" }, { status: 401 }));
    const missing = contextFor(() => Response.json({ error: "Company not found", code: "NOT_FOUND" }, { status: 404 }));

    await expect(indexedActionHandlers.search_companies!({ cursor: "abc" }, tier)).rejects.toMatchObject({
      status: 400,
    });
    await expect(indexedActionHandlers.get_company!({ slug: "stripe" }, badKey)).rejects.toMatchObject({
      status: 401,
    });
    await expect(indexedActionHandlers.get_company!({ slug: "missing-co" }, missing)).rejects.toMatchObject({
      status: 404,
      message: "Company not found",
    });
  });

  it("validates a key against the free usage endpoint and turns a rejection into a field error", async () => {
    const ok = await validateIndexedCredential(
      { apiKey: "idx_test" },
      {
        fetcher: (async (url: URL | string) => {
          expect(new URL(url).pathname).toBe("/api/v1/usage");
          return Response.json({ data: { tier: "free", credits_remaining: 25 } });
        }) as typeof fetch,
      },
    );
    expect(ok.profile).toMatchObject({ displayName: "Indexed API Key (free plan)" });
    expect(ok.metadata).toMatchObject({ tier: "free", creditsRemaining: 25 });

    await expect(
      validateIndexedCredential(
        { apiKey: "bad" },
        { fetcher: (async () => Response.json({ error: "Invalid API key" }, { status: 401 })) as typeof fetch },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
