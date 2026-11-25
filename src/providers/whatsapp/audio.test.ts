import type { ExecutionContext } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "../provider-runtime.ts";
import { downloadWhatsAppAudio } from "./audio.ts";

vi.mock("../provider-runtime.ts", async (original) => ({
  ...(await original<typeof import("../provider-runtime.ts")>()),
  providerFetch: vi.fn(),
}));
const context: ExecutionContext = {
  getCredential: async () => ({
    authType: "api_key",
    apiKey: "secret",
    values: {},
    metadata: {},
    profile: { accountId: "account", displayName: "test", grantedScopes: [] },
  }),
};
const input = { method: "GET", endpoint: "/123", query: { phone_number_id: "456" } };
const metadata = {
  url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123",
  mime_type: "audio/ogg",
  file_size: 3,
};
afterEach(() => vi.resetAllMocks());

describe("WhatsApp audio transport", () => {
  it("checks phone ownership and returns bounded bytes without a base64 or JSON payload", async () => {
    vi.mocked(providerFetch)
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const result = await downloadWhatsAppAudio(input, context);
    expect(result).toEqual({
      ok: true,
      response: { status: 200, headers: { "content-type": "audio/ogg" }, data: new Uint8Array([1, 2, 3]) },
    });
    expect(String(vi.mocked(providerFetch).mock.calls[0]?.[0])).toContain("/123?phone_number_id=456");
    for (const [, init] of vi.mocked(providerFetch).mock.calls) {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
    }
  });
  it.each([
    "https://attacker.example/audio",
    "http://lookaside.fbsbx.com/audio",
    "https://lookaside.fbsbx.com.attacker.example/audio",
    "https://user:pass@lookaside.fbsbx.com/audio",
  ])("rejects credential destination %s", async (url) => {
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json({ ...metadata, url }));
    expect((await downloadWhatsAppAudio(input, context)).ok).toBe(false);
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
  it("does not download oversized or non-audio media", async () => {
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json({ ...metadata, file_size: 10 * 1024 * 1024 + 1 }));
    expect(await downloadWhatsAppAudio(input, context)).toMatchObject({ ok: false });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
  it("enforces the byte limit when Content-Length is absent", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
      },
      cancel,
    });
    vi.mocked(providerFetch).mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response(body));
    expect(await downloadWhatsAppAudio(input, context)).toMatchObject({
      ok: false,
      error: { details: { status: 413 } },
    });
    expect(cancel).toHaveBeenCalled();
  });
  it("refuses a missing phone binding before resolving credentials or downloading", async () => {
    expect((await downloadWhatsAppAudio({ method: "GET", endpoint: "/123" }, context)).ok).toBe(false);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

it("does not leak signed media URLs through network failure messages", async () => {
  vi.mocked(providerFetch).mockRejectedValueOnce(
    new Error("Network error at https://lookaside.fbsbx.com/audio?token=SECRET"),
  );
  const result = await downloadWhatsAppAudio(input, context);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(JSON.stringify(result)).not.toContain("https://");
});

it.each(["metadata", "download"])("rejects a redirect at the %s hop without forwarding credentials", async (hop) => {
  if (hop === "download") vi.mocked(providerFetch).mockResolvedValueOnce(Response.json(metadata));
  vi.mocked(providerFetch).mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
  );
  expect((await downloadWhatsAppAudio(input, context)).ok).toBe(false);
  expect(providerFetch).toHaveBeenCalledTimes(hop === "download" ? 2 : 1);
  for (const [, init] of vi.mocked(providerFetch).mock.calls) expect(init?.redirect).toBe("manual");
});
