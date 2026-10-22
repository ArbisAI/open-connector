import type { IntegrationReceiveContext, IntegrationReconcileContext } from "../../triggers/common/integration.ts";
import type { ConnectorProxy, ConnectorProxyRequest, ConnectorProxyResult } from "../../triggers/common/proxy.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { beforeEach, describe, expect, it } from "vitest";
import { PermanentIntegrationError } from "../../triggers/common/integration.ts";
import { bytes } from "../../triggers/signature.ts";
import { telnyxMessageReceived } from "./trigger-on-message-received.ts";

const now = new Date("2026-10-01T00:00:00.000Z");
const nowTimestamp = String(Math.floor(now.getTime() / 1000));
const callbackUrl = "https://arbis.example/api/channels/telnyx/inbound/channel-1";
let privateKey: CryptoKey;
let publicKey: string;

beforeEach(async () => {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in keys)) throw new Error("Ed25519 key generation returned a single key.");
  privateKey = keys.privateKey;
  publicKey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))).toString("base64");
});

function envelope(payload: Record<string, unknown> = {}) {
  return {
    data: {
      event_type: "message.received",
      id: "event-1",
      occurred_at: now.toISOString(),
      payload: {
        id: "message-1",
        from: { phone_number: "+13125550001" },
        to: [{ phone_number: "+17735550002" }],
        text: "Where is my order?",
        media: [],
        received_at: "2026-09-30T23:59:59.503+00:00",
        ...payload,
      },
    },
  };
}

async function sign(body: string, signedTimestamp = nowTimestamp): Promise<string> {
  const payload = new TextEncoder().encode(`${signedTimestamp}|${body}`);
  return Buffer.from(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payload))).toString(
    "base64",
  );
}

function receiveContext(body: string, signature: string, signedTimestamp = nowTimestamp): IntegrationReceiveContext {
  return {
    admit: true,
    bindingId: "binding-key",
    callbackSecret: "callback-secret",
    config: { messagingProfileId: "profile-1", publicKey },
    connector: {
      async execute(): Promise<ConnectorProxyResult> {
        throw new Error("The receive path does not call the proxy.");
      },
    },
    current: true,
    header: (name) =>
      name == "telnyx-signature-ed25519" ? signature : name == "telnyx-timestamp" ? signedTimestamp : undefined,
    method: "POST",
    now,
    payload: JSON.parse(body) as JsonValue,
    query: () => undefined,
    rawBody: bytes(body),
  };
}

function proxy(
  respond: (request: ConnectorProxyRequest) => ConnectorProxyResult,
  calls: ConnectorProxyRequest[] = [],
): { connector: ConnectorProxy; calls: ConnectorProxyRequest[] } {
  return {
    connector: {
      async execute(request) {
        calls.push(request);
        return respond(request);
      },
    },
    calls,
  };
}

function profileResponse(webhookUrl: string | null): ConnectorProxyResult {
  return { data: { data: { id: "profile-1", webhook_url: webhookUrl } }, status: 200 };
}

function reconcileContext(connector: ConnectorProxy, active = true): IntegrationReconcileContext {
  return {
    active,
    callbackSecret: "callback-secret",
    config: { messagingProfileId: "profile-1", publicKey },
    connector,
    endpointUrl: callbackUrl,
    idempotencyKey: "binding-key",
    now,
  };
}

describe("telnyxMessageReceived.receive", () => {
  it("emits a verified inbound message", async () => {
    const body = JSON.stringify(envelope());
    await expect(telnyxMessageReceived.receive(receiveContext(body, await sign(body)))).resolves.toEqual({
      dedupeKey: "event-1",
      outcome: "event",
      outputs: {
        kind: "message",
        messageId: "message-1",
        from: "+13125550001",
        to: "+17735550002",
        text: "Where is my order?",
        media: [],
        receivedAt: "2026-09-30T23:59:59.503+00:00",
      },
    });
  });

  it("normalizes MMS media and keeps media-only messages", async () => {
    const body = JSON.stringify(
      envelope({
        text: null,
        media: [
          { url: "https://media.telnyx.com/photo.png", content_type: "image/png", size: 102400 },
          { content_type: "image/png" },
        ],
      }),
    );
    await expect(telnyxMessageReceived.receive(receiveContext(body, await sign(body)))).resolves.toEqual({
      dedupeKey: "event-1",
      outcome: "event",
      outputs: {
        kind: "message",
        messageId: "message-1",
        from: "+13125550001",
        to: "+17735550002",
        text: null,
        media: [{ url: "https://media.telnyx.com/photo.png", contentType: "image/png", size: 102400 }],
        receivedAt: "2026-09-30T23:59:59.503+00:00",
      },
    });
  });

  it("refuses stale, tampered and unparseable deliveries", async () => {
    const body = JSON.stringify(envelope());
    const refused = { body: "", contentType: "text/plain", outcome: "respond", status: 404 };
    await expect(
      telnyxMessageReceived.receive(receiveContext(body, await sign(body, "1000000"), "1000000")),
    ).resolves.toEqual(refused);
    await expect(
      telnyxMessageReceived.receive(receiveContext(JSON.stringify(envelope({ text: "tampered" })), await sign(body))),
    ).resolves.toEqual(refused);
    await expect(telnyxMessageReceived.receive(receiveContext(body, "not base64"))).resolves.toEqual(refused);
  });

  it("ignores unknown events and signed messages without identity", async () => {
    const other = JSON.stringify({ data: { event_type: "message.updated", id: "event-2", payload: {} } });
    await expect(telnyxMessageReceived.receive(receiveContext(other, await sign(other)))).resolves.toEqual({
      outcome: "ignored",
      reason: "Only Telnyx message and delivery events are supported.",
    });
    const missing = JSON.stringify({ data: { event_type: "message.received", id: "event-3", payload: { to: [] } } });
    await expect(telnyxMessageReceived.receive(receiveContext(missing, await sign(missing)))).resolves.toEqual({
      outcome: "ignored",
      reason: "The Telnyx inbound message identity is missing.",
    });
  });

  it("emits a delivery status for message.finalized", async () => {
    const body = JSON.stringify({
      data: {
        event_type: "message.finalized",
        id: "event-4",
        payload: {
          id: "outbound-1",
          to: [{ phone_number: "+17735550002", status: "delivery_failed" }],
          errors: [
            {
              code: "40300",
              title: "Destination number unreachable",
              detail: "The destination number is not reachable on the carrier network.",
            },
          ],
          encoding: "GSM-7",
          parts: 2,
          cost: { amount: "0.0051", currency: "USD" },
        },
      },
    });
    await expect(telnyxMessageReceived.receive(receiveContext(body, await sign(body)))).resolves.toEqual({
      dedupeKey: "event-4",
      outcome: "event",
      outputs: {
        kind: "delivery",
        messageId: "outbound-1",
        status: "delivery_failed",
        errorCode: "40300",
        errorTitle: "Destination number unreachable",
        errorDetail: "The destination number is not reachable on the carrier network.",
        encoding: "GSM-7",
        parts: 2,
        costAmount: "0.0051",
        costCurrency: "USD",
      },
    });
  });

  it("emits a non-terminal delivery status for message.sent", async () => {
    const body = JSON.stringify({
      data: {
        event_type: "message.sent",
        id: "event-5",
        payload: { id: "outbound-2", to: [{ phone_number: "+17735550002", status: "sent" }] },
      },
    });
    await expect(telnyxMessageReceived.receive(receiveContext(body, await sign(body)))).resolves.toEqual({
      dedupeKey: "event-5",
      outcome: "event",
      outputs: {
        kind: "delivery",
        messageId: "outbound-2",
        status: "sent",
        errorCode: null,
        errorTitle: null,
        errorDetail: null,
        encoding: null,
        parts: null,
        costAmount: null,
        costCurrency: null,
      },
    });
  });

  it("ignores a delivery event without a message id", async () => {
    const body = JSON.stringify({
      data: { event_type: "message.finalized", id: "event-6", payload: { to: [] } },
    });
    await expect(telnyxMessageReceived.receive(receiveContext(body, await sign(body)))).resolves.toEqual({
      outcome: "ignored",
      reason: "The Telnyx delivery event identity is missing.",
    });
  });
});

describe("telnyxMessageReceived.reconcile", () => {
  it("links the webhook URL when the profile has none", async () => {
    const { connector, calls } = proxy(() => profileResponse(null));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(connector))).resolves.toEqual({ outcome: "ready" });
    expect(calls).toEqual([
      { endpoint: "/messaging_profiles/profile-1", method: "GET" },
      { body: { webhook_url: callbackUrl }, endpoint: "/messaging_profiles/profile-1", method: "PATCH" },
    ]);
  });

  it("is idempotent when the profile already points at the callback", async () => {
    const { connector, calls } = proxy(() => profileResponse(callbackUrl));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(connector))).resolves.toEqual({ outcome: "ready" });
    expect(calls).toHaveLength(1);
  });

  it("refuses to overwrite a webhook owned by another system", async () => {
    const { connector } = proxy(() => profileResponse("https://other.example/hooks"));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(connector))).rejects.toThrow(
      PermanentIntegrationError,
    );
    await expect(telnyxMessageReceived.reconcile(reconcileContext(connector))).rejects.toThrow(
      "already sends webhooks to https://other.example/hooks",
    );
  });

  it("clears the webhook URL only when it owns it", async () => {
    const owned = proxy(() => profileResponse(callbackUrl));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(owned.connector, false))).resolves.toEqual({
      outcome: "ready",
    });
    expect(owned.calls.at(-1)).toEqual({
      body: { webhook_url: null },
      endpoint: "/messaging_profiles/profile-1",
      method: "PATCH",
    });

    const foreign = proxy(() => profileResponse("https://other.example/hooks"));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(foreign.connector, false))).resolves.toEqual({
      outcome: "ready",
    });
    expect(foreign.calls).toHaveLength(1);
  });

  it("fails permanently when the messaging profile is missing", async () => {
    const { connector } = proxy(() => ({ data: { errors: [{ detail: "Not found" }] }, status: 404 }));
    await expect(telnyxMessageReceived.reconcile(reconcileContext(connector))).rejects.toThrow(
      "The Telnyx messaging profile does not exist.",
    );
  });
});
