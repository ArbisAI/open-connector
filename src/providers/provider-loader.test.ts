import type { ProviderOAuthRuntime } from "../oauth/oauth-token.ts";

import { describe, expect, it, vi } from "vitest";
import { ProviderLoader } from "./provider-loader.ts";

const oauthRuntime: ProviderOAuthRuntime = {
  async refreshAccessToken() {
    return {
      accessToken: "refreshed-token",
      tokenType: "Bearer",
      metadata: {},
    };
  },
};

describe("ProviderLoader OAuth runtime", () => {
  it("returns no OAuth capability from a standard provider runtime module", async () => {
    const loadRuntime = vi.fn(async () => ({ executors: {} }));
    const loader = new ProviderLoader({ standard: loadRuntime });

    await expect(loader.loadProviderOAuthRuntime("standard")).resolves.toBeUndefined();
    expect(loadRuntime).toHaveBeenCalledOnce();
  });

  it("loads an optional OAuth capability from the provider runtime module", async () => {
    const loadRuntime = vi.fn(async () => ({ executors: {}, oauth: oauthRuntime }));
    const loader = new ProviderLoader({ instagram: loadRuntime });

    await expect(loader.loadProviderOAuthRuntime("instagram")).resolves.toBe(oauthRuntime);
    expect(loadRuntime).toHaveBeenCalledOnce();
  });
});

it("loads audio only from the selected provider registry", async () => {
  const audioDownloader = vi.fn();
  const load = vi.fn(async () => ({ executors: {}, audioDownloader }));
  const loader = new ProviderLoader({ whatsapp: load });
  expect(load).not.toHaveBeenCalled();
  await expect(loader.loadAudioDownloader("github")).resolves.toBeUndefined();
  expect(load).not.toHaveBeenCalled();
  await expect(loader.loadAudioDownloader("whatsapp")).resolves.toBe(audioDownloader);
  expect(load).toHaveBeenCalledOnce();
});
