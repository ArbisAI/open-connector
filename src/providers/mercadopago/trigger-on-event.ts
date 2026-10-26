import type { IntegrationDefinition } from "../../triggers/common/integration.ts";
import type { JsonValue } from "../../triggers/common/types.ts";

import { bytes, verifyHexHmac } from "../../triggers/signature.ts";
import { snapshot } from "./trigger-on-event.definition.ts";

/**
 * Mercado Pago signs `id:{data.id};request-id:{x-request-id};ts:{ts};` with the webhook secret.
 * The notification body is a pointer. Callers fetch the resource themselves.
 */
export const mercadoPagoEvent: IntegrationDefinition = {
  initialState: { checkpoint: null, subscription: {} },
  snapshot,
  async receive(context) {
    const header = context.header("x-signature") ?? "";
    const requestId = context.header("x-request-id") ?? "";
    const parsed = parseSignature(header);
    const resourceId = resourceIdOf(context.payload, context.query("data.id") ?? context.query("id"));
    const manifest = `id:${resourceId};request-id:${requestId};ts:${parsed.ts};`;
    const valid = parsed.v1
      ? await verifyHexHmac(context.callbackSecret, [bytes(manifest)], parsed.v1)
      : false;
    if (!valid) {
      return { body: "", contentType: "text/plain", outcome: "respond", status: 401 };
    }
    const payload = objectPayload(context.payload);
    if (!payload) return { outcome: "ignored", reason: "Mercado Pago notification body is missing." };
    const topic = typeof payload.type === "string" ? payload.type : "";
    const action = typeof payload.action === "string" ? payload.action : "";
    const topics = resolveTopics(context.config);
    if (!topic || !topics.includes(topic)) {
      return { outcome: "ignored", reason: "Mercado Pago topic is not subscribed." };
    }
    const notificationId = payload.id == null ? "" : String(payload.id);
    return {
      dedupeKey: notificationId || undefined,
      outcome: "event",
      outputs: {
        topic,
        action,
        notificationId,
        resourceId,
        liveMode: payload.live_mode === true,
      },
    };
  },
  async reconcile(context) {
    if (!context.active) return { outcome: "ready" };
    return { outcome: "ready" };
  },
};

export function parseSignature(header: string): { ts: string; v1: string } {
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
      }),
  );
  return { ts: parts.ts ?? "", v1: parts.v1 ?? "" };
}

function resourceIdOf(payload: unknown, fromQuery: string | undefined): string {
  if (fromQuery) return fromQuery;
  const data = objectPayload(payload)?.data;
  if (data && typeof data === "object" && !Array.isArray(data) && "id" in data && data.id != null) {
    return String(data.id);
  }
  return "";
}

function objectPayload(payload: unknown): Record<string, JsonValue> | null {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Record<string, JsonValue>;
}

function resolveTopics(config: Readonly<Record<string, JsonValue>>): string[] {
  const topics = config.topics;
  return Array.isArray(topics) ? topics.filter((topic): topic is string => typeof topic === "string") : [];
}
