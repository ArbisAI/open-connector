import type { WhatsAppActionContext } from "./runtime.ts";

import { describe, expect, it, vi } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { whatsappActions } from "./actions.ts";
import { whatsappActionHandlers, whatsappGraphApiVersion } from "./runtime.ts";

function context(payload: object = { success: true }, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  const signal = new AbortController().signal;
  const ctx: WhatsAppActionContext = { accessToken: "test-token", fetcher, signal };
  return { fetcher, signal, ctx };
}
const input = { phone_number_id: "123456", message_id: "wamid.incoming" };

describe("WhatsApp read receipts and native typing", () => {
  it("sends the read receipt and native text typing payload using the authenticated provider fetcher", async () => {
    const { fetcher, signal, ctx } = context();
    await expect(whatsappActionHandlers.mark_message_read({ ...input, typing_indicator: true }, ctx)).resolves.toEqual({
      success: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://graph.facebook.com/${whatsappGraphApiVersion}/123456/messages`);
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.incoming",
      typing_indicator: { type: "text" },
    });
  });
  it("can mark read without displaying the typing indicator", async () => {
    const { fetcher, ctx } = context();
    await whatsappActionHandlers.mark_message_read(input, ctx);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.incoming",
    });
  });
  it("requires incoming-message identity and the existing WhatsApp messaging permission", () => {
    const action = whatsappActions.find((candidate) => candidate.id === "whatsapp.mark_message_read")!;
    expect(action.providerPermissions).toEqual(["whatsapp_business_messaging"]);
    expect(validateActionInput(action, input).valid).toBe(true);
    expect(validateActionInput(action, { phone_number_id: "123456" }).valid).toBe(false);
    expect(validateActionInput(action, { ...input, typing_indicator: "yes" }).valid).toBe(false);
  });
  it("does not report success for a rejected or unconfirmed receipt and never retries", async () => {
    for (const [payload, status] of [
      [{ success: false }, 200],
      [{ error: { code: 190, message: "Expired" } }, 401],
    ] as const) {
      const { fetcher, ctx } = context(payload, status);
      await expect(whatsappActionHandlers.mark_message_read(input, ctx)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
