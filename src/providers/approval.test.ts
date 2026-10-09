import type { RuntimeActionDefinition } from "../catalog-store.ts";
import type { PreparedAction } from "./approval.ts";

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { buildActionPreview } from "../server/actions/action-preview.ts";
import { approvedHttpFetch, prepareHttpAction, runApprovedHttpAction } from "./approval.ts";
import { gmailActionHandlers } from "./gmail/executors.ts";
import { encodeMimeMessage } from "./gmail/message.ts";
import { googlecalendarEventActionHandlers } from "./googlecalendar/runtime-events.ts";
import { defineProviderExecutors } from "./provider-runtime.ts";

const action = (id: string): RuntimeActionDefinition => ({
  id,
  service: id.split(".")[0]!,
  name: id.split(".").slice(1).join("."),
  description: "",
  operationType: "write",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  requiredScopes: [],
  providerPermissions: [],
  execution: {
    locallyExecutable: true,
    catalogOnly: false,
    requiredAuthTypes: ["oauth2"],
    noAuthRunnable: false,
    needsCredential: true,
  },
});
const prepare = (id: string, captured: Pick<PreparedAction, "request" | "reads">): PreparedAction => ({
  version: 1,
  actionId: id,
  connectionId: "account-1",
  inputHash: "",
  ...captured,
});

describe("saved provider approvals", () => {
  it("captures the real Gmail aliases and full body without sending, then executes the same MIME", async () => {
    const input = {
      to: ["maya@example.com"],
      recipientEmail: "leo@example.com",
      extraRecipients: ["sam@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Timeline",
      body: "  " + "Full body ü\n".repeat(100) + "  ",
      messageBody: "must not replace body",
    };
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      Response.json({ id: "sent" }),
    );
    const run = (fetcher: typeof fetch) =>
      gmailActionHandlers.send_email(input, { userId: "me", accessToken: "secret", fetcher });
    const saved = prepare("gmail.send_email", await prepareHttpAction(run, transport as typeof fetch));
    expect(transport).not.toHaveBeenCalled();
    const preview = await buildActionPreview(action("gmail.send_email"), undefined, input, saved);
    expect(preview.fields.find((field) => field.key === "to")?.value).toContain("maya@example.com");
    expect(preview.fields.find((field) => field.key === "to")?.value).toContain("leo@example.com");
    expect(preview.fields.find((field) => field.key === "bcc")?.value).toBe("bcc@example.com");
    expect(preview.body).toBe(input.body.trim());
    expect(JSON.stringify(saved)).not.toContain("secret");
    await run(approvedHttpFetch(transport as typeof fetch, saved));
    expect(transport).toHaveBeenCalledTimes(1);
    const sent = new Request(transport.mock.calls[0]?.[0], transport.mock.calls[0]?.[1]);
    expect(Buffer.from(await sent.arrayBuffer()).toString("base64")).toBe(saved.request?.bodyBase64);
  });

  it("prepares through the shared executor and uses the current credential only at execution", async () => {
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      Response.json({ id: "sent" }),
    );
    let token = "before-approval";
    const executors = defineProviderExecutors({
      service: "gmail",
      handlers: { send_email: gmailActionHandlers.send_email },
      createContext: async () => ({ userId: "me", accessToken: token, fetcher: transport as typeof fetch }),
    });
    const executor = executors["gmail.send_email"]!;
    const input = { to: "maya@example.com", subject: "Saved", body: "Reviewed body" };
    const result = await executor(input, {
      getCredential: async () => undefined,
      approval: { mode: "prepare", actionId: "gmail.send_email" },
    });
    expect(result.ok).toBe(true);
    expect(transport).not.toHaveBeenCalled();
    const saved = prepare("gmail.send_email", result.output as Pick<PreparedAction, "request" | "reads">);
    token = "after-approval";
    const executed = await executor(input, {
      getCredential: async () => undefined,
      approval: { mode: "execute", prepared: saved },
    });
    expect(executed.ok).toBe(true);
    const sent = new Request(transport.mock.calls[0]![0], transport.mock.calls[0]![1]);
    expect(sent.headers.get("authorization")).toBe("Bearer after-approval");
    expect(Buffer.from(await sent.arrayBuffer()).toString("base64")).toBe(saved.request!.bodyBase64);
  });

  it("freezes reply recipients and subject from the reviewed message", async () => {
    const original = {
      id: "message-1",
      threadId: "thread-1",
      payload: {
        headers: [
          { name: "From", value: "Maya <maya@example.com>" },
          { name: "Subject", value: "Reviewed subject" },
          { name: "Message-ID", value: "<original@example.com>" },
        ],
      },
    };
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      init?.method === "POST" ? Response.json({ id: "sent" }) : Response.json(original),
    );
    const input = { messageId: "message-1", threadId: "thread-1", body: "Approved reply" };
    const run = (fetcher: typeof fetch) =>
      gmailActionHandlers.reply_email(input, { userId: "me", accessToken: "secret", fetcher });
    const saved = prepare("gmail.reply_email", await prepareHttpAction(run, transport as typeof fetch));
    expect(transport).toHaveBeenCalledTimes(1);
    original.payload.headers[0]!.value = "Other <other@example.com>";
    const preview = await buildActionPreview(action("gmail.reply_email"), undefined, input, saved);
    expect(preview.fields.find((field) => field.key === "to")?.value).toContain("maya@example.com");
    transport.mockClear();
    await run(approvedHttpFetch(transport as typeof fetch, saved));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("saves draft contents in the send request instead of relying on a mutable draft ID", async () => {
    const raw = encodeMimeMessage({ to: ["maya@example.com"], subject: "Draft review", body: "Saved draft text" });
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ id: "sent" })
        : Response.json({ id: "draft-1", message: { raw, threadId: "thread-1" } }),
    );
    const input = { draftId: "draft-1" };
    const run = (fetcher: typeof fetch) =>
      gmailActionHandlers.send_draft(input, { userId: "me", accessToken: "secret", fetcher });
    const saved = prepare("gmail.send_draft", await prepareHttpAction(run, transport as typeof fetch));
    const preview = await buildActionPreview(action("gmail.send_draft"), undefined, input, saved);
    expect(preview.body).toBe("Saved draft text");
    expect(JSON.parse(Buffer.from(saved.request!.bodyBase64, "base64").toString()).message.raw).toBe(raw);
  });

  it("preserves the reviewed calendar update and its If-Match condition", async () => {
    const current = {
      etag: "version-1",
      summary: "Review",
      start: { dateTime: "2026-10-16T14:00:00-04:00" },
      end: { dateTime: "2026-10-16T14:30:00-04:00" },
    };
    const transport = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      init?.method === "PUT" ? Response.json({ id: "event-1" }) : Response.json(current),
    );
    const input = {
      calendarId: "primary",
      eventId: "event-1",
      event: { start: { dateTime: "2026-10-16T15:00:00-04:00" }, end: { dateTime: "2026-10-16T15:30:00-04:00" } },
      sendUpdates: "all",
    };
    const run = (fetcher: typeof fetch) =>
      googlecalendarEventActionHandlers.update_event!(input, { accessToken: "secret", fetcher });
    const saved = prepare("googlecalendar.update_event", await prepareHttpAction(run, transport as typeof fetch));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(saved.request?.headers["if-match"]).toBe("version-1");
    const preview = await buildActionPreview(action("googlecalendar.update_event"), undefined, input, saved, current);
    expect(preview.fields.find((field) => field.key === "sendUpdates")?.value).toBe("all");
    expect(preview.fields.find((field) => field.key === "start")).toMatchObject({
      before: current.start,
      value: input.event.start,
    });
    transport.mockClear();
    await run(approvedHttpFetch(transport as typeof fetch, saved));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("distinguishes Drive trash from permanent deletion and retains the exact target", async () => {
    const makeSaved = (method: string, body: object) =>
      prepare("googledrive.files.update", {
        reads: [],
        request: {
          url: "https://www.googleapis.com/drive/v3/files/file-1",
          method,
          headers: {},
          bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
        },
      });
    const trash = await buildActionPreview(
      action("googledrive.files.update"),
      undefined,
      { fileId: "file-1" },
      makeSaved("PATCH", { trashed: true }),
      { name: "Old plan.pdf" },
    );
    const deletion = await buildActionPreview(
      action("googledrive.files.delete"),
      undefined,
      { fileId: "file-1" },
      makeSaved("DELETE", {}),
      { name: "Old plan.pdf" },
    );
    expect(trash).toMatchObject({ kind: "deletion", effect: "trash" });
    expect(deletion).toMatchObject({ kind: "deletion", effect: "delete" });
    expect(deletion.fields).toContainEqual({ key: "target", value: "Old plan.pdf" });
    expect(deletion.fields).toContainEqual({ key: "fileId", value: "file-1" });
  });

  it("fails before any write when the complete preview exceeds its limit", async () => {
    const transport = vi.fn(async () => Response.json({}));
    await expect(
      prepareHttpAction(
        (fetcher) => fetcher("https://api.notion.com/v1/pages", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
        transport as typeof fetch,
      ),
    ).rejects.toThrow("exceeds");
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps a wrapped post-dispatch denial uncertain instead of reporting no execution", async () => {
    const transport = vi.fn(async () => Response.json({}));
    const saved = prepare("notion.append_block", {
      reads: [],
      request: {
        url: "https://api.notion.com/v1/blocks/page-1/children",
        method: "PATCH",
        headers: {},
        bodyBase64: "",
      },
    });
    const run = async (fetcher: typeof fetch) => {
      try {
        await fetcher(saved.request!.url, { method: "PATCH" });
        await fetcher(saved.request!.url, { method: "PATCH" });
      } catch {
        throw new Error("Provider wrapper");
      }
    };
    await expect(runApprovedHttpAction(run, transport as typeof fetch, saved)).rejects.toMatchObject({
      outcome: "unknown",
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retains a denial when a handler converts its transport error into a fallback result", async () => {
    const transport = vi.fn(async () => Response.json({}));
    const saved = prepare("notion.append_block", {
      reads: [],
      request: {
        url: "https://api.notion.com/v1/blocks/page-1/children",
        method: "PATCH",
        headers: {},
        bodyBase64: "",
      },
    });
    const run = async (fetcher: typeof fetch) => {
      try {
        await fetcher("https://api.notion.com/v1/blocks/page-2/children", { method: "PATCH" });
      } catch {
        return { fallback: true };
      }
    };
    await expect(runApprovedHttpAction(run, transport as typeof fetch, saved)).rejects.toMatchObject({
      outcome: "not_executed",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("shows Notion document text and preserves links while identifying archived blocks as trash", async () => {
    const body = {
      children: [
        {
          type: "paragraph",
          paragraph: { rich_text: [{ text: { content: "Full document", link: { url: "https://example.com" } } }] },
        },
      ],
    };
    const saved = prepare("notion.append_block", {
      reads: [],
      request: {
        url: "https://api.notion.com/v1/blocks/page-1/children",
        method: "PATCH",
        headers: {},
        bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
      },
    });
    const preview = await buildActionPreview(action("notion.append_block"), undefined, { pageId: "page-1" }, saved);
    expect(preview).toMatchObject({ effect: "append", body: "Full document (https://example.com)" });
    const removed = await buildActionPreview(
      action("notion.delete_block"),
      undefined,
      { blockId: "block-1" },
      { ...saved, request: { ...saved.request!, method: "DELETE", bodyBase64: "" } },
    );
    expect(removed.effect).toBe("trash");
  });

  it("blocks changed write targets and extra writes before dispatch", async () => {
    const transport = vi.fn(async () => Response.json({}));
    const saved = prepare("notion.append_block", {
      reads: [],
      request: {
        url: "https://api.notion.com/v1/blocks/page-1/children",
        method: "PATCH",
        headers: {},
        bodyBase64: "",
      },
    });
    const fetcher = approvedHttpFetch(transport as typeof fetch, saved);
    await expect(fetcher("https://api.notion.com/v1/blocks/page-2/children", { method: "PATCH" })).rejects.toThrow(
      "changed after review",
    );
    expect(transport).not.toHaveBeenCalled();
    await fetcher(saved.request!.url, { method: "PATCH" });
    await expect(fetcher(saved.request!.url, { method: "PATCH" })).rejects.toThrow("changed after review");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
