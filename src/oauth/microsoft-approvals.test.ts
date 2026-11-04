import type { ExecutionContext, ResolvedCredential } from "../core/types.ts";
import type { PreparedAction } from "../providers/approval.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { setDefaultGuardedFetchDnsLookup } from "../core/guarded-fetch.ts";
import { provider as mailProvider } from "../providers/outlook/definition.ts";
import { executors as mail } from "../providers/outlook/executors.ts";
import { provider as calendarProvider } from "../providers/outlook_calendar/definition.ts";
import { executors as calendar } from "../providers/outlook_calendar/executors.ts";
import { buildActionPreview } from "../server/actions/action-preview.ts";

const credential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "secret",
  tokenType: "Bearer",
  profile: { accountId: "person", displayName: "person@example.com", grantedScopes: [] },
  metadata: {},
};
beforeEach(() => setDefaultGuardedFetchDnsLookup(null));
afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});
const examples = [
  ["outlook.create_draft", { subject: "Draft", body: "Review me", toRecipients: ["person@example.com"] }],
  ["outlook.update_draft", { messageId: "draft-id", subject: "Changed" }],
  ["outlook.send_draft", { messageId: "draft-id" }],
  ["outlook.send_email", { subject: "Approved", body: "Only this body", toRecipients: ["person@example.com"] }],
  ["outlook.reply_email", { messageId: "mail-id", comment: "Approved reply" }],
  [
    "outlook_calendar.create_event",
    {
      event: {
        subject: "Planning",
        start: { dateTime: "2026-11-01T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-01T11:00:00", timeZone: "UTC" },
      },
    },
  ],
  ["outlook_calendar.update_event", { eventId: "event-id", event: { subject: "Updated planning" } }],
  ["outlook_calendar.delete_event", { eventId: "event-id" }],
  ["outlook_calendar.cancel_event", { eventId: "event-id", comment: "Cancelled" }],
  ["outlook_calendar.accept_event", { eventId: "event-id" }],
  ["outlook_calendar.decline_event", { eventId: "event-id" }],
  ["outlook_calendar.tentatively_accept_event", { eventId: "event-id" }],
] as const;
describe("Outlook write approvals", () => {
  it.each(examples)("prepares %s without writing and replays exactly the approved request", async (actionId, input) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(url, init));
      return new Response(null, { status: 204 });
    });
    const execute = (mail[actionId] ?? calendar[actionId])!;
    const context: ExecutionContext = {
      getCredential: async () => credential,
      approval: { mode: "prepare", actionId },
    };
    const result = await execute(input, context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const saved = result.output as PreparedAction;
    expect(requests).toHaveLength(0);
    expect(saved.request).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain("secret");
    const catalog = createCatalogStore([mailProvider, calendarProvider]);
    const preview = await buildActionPreview(catalog.actionsById.get(actionId)!, undefined, input, saved);
    expect(["email", "calendar", "deletion"]).toContain(preview.kind);
    await execute(input, { getCredential: async () => credential, approval: { mode: "execute", prepared: saved } });
    expect(requests).toHaveLength(1);
    expect(Buffer.from(await requests[0]!.arrayBuffer()).toString("base64")).toBe(saved.request?.bodyBase64);
    expect(requests[0]!.url).toBe(saved.request?.url);
  });
});

it("shows the new reply text and the sender rather than the received message body and recipients", async () => {
  const catalog = createCatalogStore([mailProvider]);
  const saved: PreparedAction = {
    version: 1,
    actionId: "outlook.reply_email",
    connectionId: "owned",
    inputHash: "",
    reads: [],
    request: {
      url: "https://graph.microsoft.com/v1.0/me/messages/original/reply",
      method: "POST",
      headers: {},
      bodyBase64: Buffer.from(JSON.stringify({ comment: "New approved reply" })).toString("base64"),
    },
  };
  const preview = await buildActionPreview(
    catalog.actionsById.get("outlook.reply_email")!,
    undefined,
    { messageId: "original" },
    saved,
    {
      subject: "Original subject",
      from: { emailAddress: { address: "sender@example.com" } },
      toRecipients: [{ emailAddress: { address: "me@example.com" } }],
      body: { content: "Original incoming body" },
    },
  );
  expect(preview.body).toBe("New approved reply");
  expect(JSON.stringify(preview.fields.find((field) => field.key === "to")?.value)).toContain("sender@example.com");
  expect(JSON.stringify(preview.fields.find((field) => field.key === "to")?.value)).not.toContain("me@example.com");
});
