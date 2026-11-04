import type { ConnectionService } from "../../connection-service.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPhoneVerificationRoutes } from "./phone-verification-routes.ts";

const id = "12345678-1234-1234-1234-123456789012";
function fixture() {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id } }));
  const resolve = vi.fn().mockResolvedValue({
    kind: "local",
    getCredential: async () => ({ authType: "api_key", apiKey: "telnyx-secret" }),
  });
  const app = createPhoneVerificationRoutes({
    connections: { resolveForExecution: resolve } as unknown as ConnectionService,
    fetcher,
  });
  const call = (
    operation = "start_phone_verification",
    input: unknown = { phoneNumber: "+14155550123" },
    token = "verify-secret",
  ) =>
    app.request(`/${operation}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
  return { fetcher, resolve, call };
}

describe("private phone verification", () => {
  beforeEach(() => {
    vi.stubEnv("PHONE_VERIFY_INTERNAL_TOKEN", "verify-secret");
    vi.stubEnv("PHONE_VERIFY_CONNECTION_ID", "private-telnyx");
    vi.stubEnv("TELNYX_VERIFY_PROFILE_ID", "private-profile");
  });
  afterEach(() => vi.unstubAllEnvs());
  it.each(["", "runtime-token", "verify-secreT"])("rejects all other credentials: %s", async (token) => {
    const f = fixture();
    expect((await f.call(undefined, undefined, token)).status).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("fails closed when the dedicated token is absent", async () => {
    vi.stubEnv("PHONE_VERIFY_INTERNAL_TOKEN", "");
    expect((await fixture().call()).status).toBe(401);
  });
  it("uses only the configured connection and profile", async () => {
    const f = fixture();
    const response = await f.call(undefined, {
      phoneNumber: "+14155550123",
      profileId: "attacker",
      connectionId: "attacker",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.resolve).toHaveBeenCalledWith("telnyx", undefined, "private-telnyx");
    const [url, options] = f.fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.telnyx.com/v2/verifications/sms");
    expect(JSON.parse(options.body)).toEqual({
      phone_number: "+14155550123",
      verify_profile_id: "private-profile",
      timeout_secs: 300,
    });
    expect(options.redirect).toBe("error");
  });
  it("checks the exact verification ID and exposes only acceptance", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ data: { response_code: "accepted", private: "hidden" } }));
    const response = await f.call("check_phone_verification", { id, code: "123456" });
    expect(await response.json()).toMatchObject({ data: { accepted: true } });
    expect(f.fetcher.mock.calls[0]![0]).toBe(`https://api.telnyx.com/v2/verifications/${id}/actions/verify`);
  });
  it.each([400, 404, 422])("handles invalid provider codes without raw provider output %i", async (status) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json({ detail: "private-code-123456" }, { status }));
    const response = await f.call("check_phone_verification", { id, code: "123456" });
    expect(await response.json()).toMatchObject({ data: { accepted: false } });
  });
  it.each(["send_message", "delete_account"])("rejects unrelated operations %s", async (operation) => {
    const f = fixture();
    expect((await f.call(operation)).status).toBe(404);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["4155550123", "+1 OR 1=1", "+00000000000"])("rejects malformed numbers %s", async (phoneNumber) => {
    const f = fixture();
    expect((await f.call(undefined, { phoneNumber })).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("sanitizes provider exceptions", async () => {
    const f = fixture();
    f.fetcher.mockRejectedValue(new Error("private-code-123456"));
    const response = await f.call();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("123456");
  });

  it.each(["1234", "12345", "1234567", "12345a"])("rejects a code that is not six digits: %s", async (code) => {
    const f = fixture();
    expect((await f.call("check_phone_verification", { id, code })).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
