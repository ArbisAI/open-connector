import type {
  IntegrationDefinition,
  IntegrationReceiveResult,
  IntegrationReconcileContext,
} from "../../triggers/common/integration.ts";
import type { ConnectorProxyRequest, ConnectorProxyResult } from "../../triggers/common/proxy.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { optionalInteger, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  IntegrationConnectionError,
  PermanentIntegrationError,
  TransientIntegrationError,
} from "../../triggers/common/integration.ts";
import { bytes, verifyEd25519 } from "../../triggers/signature.ts";
import { snapshot } from "./trigger-on-message-received.definition.ts";

/** Telnyx signs webhooks over `{timestamp}|{body}` with the account Ed25519 key. */
const signatureToleranceSeconds = 5 * 60;
const messagingProfilesPath = "/messaging_profiles";

interface Config {
  readonly messagingProfileId: string;
  readonly publicKey: string;
}

export const telnyxMessageReceived: IntegrationDefinition = {
  initialState: { checkpoint: null, subscription: {} },
  snapshot,
  async receive(context) {
    const config = resolveConfig(context.config);
    const signature = context.header("telnyx-signature-ed25519");
    const rawTimestamp = context.header("telnyx-timestamp");
    const timestamp = readTimestamp(rawTimestamp);
    if (
      config.publicKey.length == 0 ||
      signature == null ||
      rawTimestamp == null ||
      timestamp == null ||
      Math.abs(context.now.getTime() - timestamp * 1000) > signatureToleranceSeconds * 1000
    ) {
      return refuse();
    }
    if (!(await verifyEd25519(config.publicKey, [bytes(`${rawTimestamp}|`), context.rawBody], signature))) {
      return refuse();
    }

    const data = optionalRecord(optionalRecord(context.payload)?.data);
    if (data == null) {
      return ignored("The Telnyx event envelope is missing.");
    }
    const eventType = optionalString(data.event_type);
    if (eventType == "message.sent" || eventType == "message.finalized") {
      return readDeliveryEvent(data);
    }
    if (eventType != "message.received") {
      return ignored("Only Telnyx message and delivery events are supported.");
    }

    const message = optionalRecord(data.payload);
    const messageId = optionalString(message?.id);
    const from = optionalString(optionalRecord(message?.from)?.phone_number);
    const to = readFirstToNumber(message?.to);
    if (messageId == null || from == null || to == null) {
      return ignored("The Telnyx inbound message identity is missing.");
    }

    return {
      dedupeKey: optionalString(data.id) ?? messageId,
      outcome: "event",
      outputs: {
        kind: "message",
        messageId,
        from,
        to,
        text: optionalString(message?.text) ?? null,
        media: readMedia(message?.media),
        receivedAt: optionalString(message?.received_at) ?? null,
      },
    };
  },
  async reconcile(context) {
    const config = resolveConfig(context.config);
    if (config.messagingProfileId.length == 0) {
      throw new PermanentIntegrationError("A Telnyx messaging profile ID is required.");
    }

    const profile = await fetchProfile(context, config.messagingProfileId);
    const current = optionalString(profile?.webhook_url) ?? "";

    if (!context.active) {
      if (current != context.endpointUrl) return { outcome: "ready" };
      const cleared = await request(context, "webhook clear", {
        endpoint: profileEndpoint(config.messagingProfileId),
        method: "PATCH",
        body: { webhook_url: null },
      });
      requireSuccess(cleared, "webhook clear");
      return { outcome: "ready" };
    }

    if (current != "" && current != context.endpointUrl) {
      throw new PermanentIntegrationError(
        `The Telnyx messaging profile already sends webhooks to ${current}. Use a dedicated messaging profile for this Trigger.`,
      );
    }
    if (current == context.endpointUrl) return { outcome: "ready" };

    const linked = await request(context, "webhook set", {
      endpoint: profileEndpoint(config.messagingProfileId),
      method: "PATCH",
      body: { webhook_url: context.endpointUrl },
    });
    requireSuccess(linked, "webhook set");
    return { outcome: "ready" };
  },
};

function resolveConfig(value: Readonly<Record<string, JsonValue>>): Config {
  return {
    messagingProfileId: optionalString(value.messagingProfileId) ?? "",
    publicKey: optionalString(value.publicKey) ?? "",
  };
}

function readTimestamp(value: string | undefined): number | undefined {
  if (value == null || !/^\d{1,12}$/.test(value)) return;
  return Number(value);
}

function refuse(): IntegrationReceiveResult {
  return { body: "", contentType: "text/plain", outcome: "respond", status: 404 };
}

function ignored(reason: string): IntegrationReceiveResult {
  return { outcome: "ignored", reason };
}

function readFirstToNumber(value: unknown): string | undefined {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const number = optionalString(optionalRecord(entry)?.phone_number);
    if (number != null) return number;
  }
  return;
}

interface TelnyxDeliveryTarget {
  readonly status?: string;
}

function readFirstToStatus(value: unknown): TelnyxDeliveryTarget | undefined {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    const record = optionalRecord(entry);
    if (record == null) continue;
    if (optionalString(record.phone_number) == null) continue;
    return { status: optionalString(record.status) };
  }
  return;
}

interface TelnyxDeliveryError {
  readonly code?: string;
  readonly title?: string;
  readonly detail?: string;
}

function readErrors(value: unknown): TelnyxDeliveryError[] {
  if (!Array.isArray(value)) return [];
  const errors: TelnyxDeliveryError[] = [];
  for (const entry of value) {
    const record = optionalRecord(entry);
    if (record == null) continue;
    errors.push({
      code: optionalString(record.code),
      title: optionalString(record.title),
      detail: optionalString(record.detail),
    });
  }
  return errors;
}

/**
 * Telnyx reports outbound progress as `message.sent` and the terminal outcome
 * as `message.finalized`. Both carry `payload.id` (the outbound message id),
 * so the host can match the event to the reply it stored after sending.
 */
function readDeliveryEvent(data: Record<string, unknown>): IntegrationReceiveResult {
  const payload = optionalRecord(data.payload);
  const messageId = optionalString(payload?.id);
  const target = readFirstToStatus(payload?.to);
  if (messageId == null || target?.status == null) {
    return ignored("The Telnyx delivery event identity is missing.");
  }
  const errors = readErrors(payload?.errors);
  const first = errors[0];
  const cost = optionalRecord(payload?.cost);

  return {
    dedupeKey: optionalString(data.id) ?? messageId,
    outcome: "event",
    outputs: {
      kind: "delivery",
      messageId,
      status: target.status,
      errorCode: first?.code ?? null,
      errorTitle: first?.title ?? null,
      errorDetail: first?.detail ?? null,
      encoding: optionalString(payload?.encoding) ?? null,
      parts: optionalInteger(payload?.parts) ?? null,
      costAmount: optionalString(cost?.amount) ?? null,
      costCurrency: optionalString(cost?.currency) ?? null,
    },
  };
}

function readMedia(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  const media: JsonValue[] = [];
  for (const entry of value) {
    const record = optionalRecord(entry);
    const url = optionalString(record?.url);
    if (url == null) continue;
    media.push({
      url,
      contentType: optionalString(record?.content_type) ?? null,
      size: optionalInteger(record?.size) ?? null,
    });
  }
  return media;
}

function profileEndpoint(profileId: string): string {
  return `${messagingProfilesPath}/${encodeURIComponent(profileId)}`;
}

async function fetchProfile(
  context: IntegrationReconcileContext,
  profileId: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await request(context, "profile read", { endpoint: profileEndpoint(profileId), method: "GET" });
  if (result.status == 404) throw new PermanentIntegrationError("The Telnyx messaging profile does not exist.");
  requireSuccess(result, "profile read");
  return optionalRecord(optionalRecord(result.data)?.data);
}

async function request(
  context: IntegrationReconcileContext,
  operation: string,
  value: ConnectorProxyRequest,
): Promise<ConnectorProxyResult> {
  try {
    return await context.connector.execute(value, context.signal);
  } catch (cause) {
    if (cause instanceof IntegrationConnectionError) throw cause;
    throw new TransientIntegrationError(`Telnyx ${operation} request failed.`, { cause });
  }
}

function requireSuccess(result: ConnectorProxyResult, operation: string): void {
  if (result.status >= 200 && result.status < 300) return;
  const record = optionalRecord(result.data);
  const message = optionalString(record?.detail) ?? optionalString(record?.message);
  if (result.status == 429) throw new TransientIntegrationError(`Telnyx ${operation} was rate limited.`);
  if ([401, 403].includes(result.status)) {
    throw new IntegrationConnectionError(`Telnyx ${operation} rejected the Connection.`);
  }
  if ([400, 404, 409, 422].includes(result.status)) {
    throw new PermanentIntegrationError(
      message == null
        ? `Telnyx ${operation} rejected the request.`
        : `Telnyx ${operation} rejected the request: ${message}`,
    );
  }
  throw new TransientIntegrationError(`Telnyx ${operation} failed with status ${result.status}.`);
}
