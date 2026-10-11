import type { RuntimeActionDefinition } from "../../catalog-store.ts";
import type { ConnectionSummary } from "../../connection-service.ts";
import type { PreparedAction } from "../../providers/approval.ts";

import { simpleParser } from "mailparser";
import { Buffer } from "node:buffer";
import { optionalRecord, optionalString } from "../../core/cast.ts";

export interface PreviewField {
  key: string;
  value: unknown;
  before?: unknown;
}

export interface ActionPreview {
  proposalId: string;
  version: 1;
  service: string;
  actionId: string;
  title: string;
  account: string;
  kind: "email" | "calendar" | "document" | "deletion" | "generic";
  effect: "send" | "create" | "update" | "append" | "replace" | "trash" | "delete" | "generic";
  fields: PreviewField[];
  resources?: Array<{ key: string; id: string; name?: string; url?: string }>;
  body?: string;
  html?: string;
  attachments?: Array<{ name: string; mimeType: string; size: number; contentBase64: string }>;
  savedInput: unknown;
}

/** Preserve rich text and link destinations while making common blocks readable. */
function blockText(block: unknown): string {
  const record = optionalRecord(block);
  if (!record) return JSON.stringify(block);
  const type = optionalString(record.type);
  const content = optionalRecord(type ? record[type] : undefined);
  if (!content) return JSON.stringify(block, null, 2);
  const richText = content.rich_text;
  const text = Array.isArray(richText)
    ? richText
        .map((part) => {
          const rich = optionalRecord(part) ?? {};
          const source = optionalRecord(rich.text);
          const value = optionalString(source?.content) ?? optionalString(rich.plain_text) ?? JSON.stringify(rich);
          const href = optionalString(optionalRecord(source?.link)?.url) ?? optionalString(rich.href);
          return href ? `${value} (${href})` : value;
        })
        .join("")
    : undefined;
  const children = Array.isArray(content.children) ? content.children.map(blockText).join("\n") : "";
  if (text === undefined) return JSON.stringify(block, null, 2);
  const prefix =
    type === "bulleted_list_item"
      ? "• "
      : type === "numbered_list_item"
        ? "1. "
        : type === "to_do"
          ? content.checked
            ? "[x] "
            : "[ ] "
          : "";
  return `${prefix}${text}${children ? `\n${children}` : ""}`;
}

/** Values come from the captured provider request, never a second model summary. */
export async function buildActionPreview(
  action: RuntimeActionDefinition,
  connection: ConnectionSummary | undefined,
  input: unknown,
  prepared: PreparedAction,
  current?: unknown,
): Promise<ActionPreview> {
  const original = optionalRecord(input) ?? {};
  const request = prepared.request;
  const bodyText = request ? Buffer.from(request.bodyBase64, "base64").toString("utf8") : "";
  let body: Record<string, unknown> = {};
  try {
    body = optionalRecord(JSON.parse(bodyText)) ?? {};
  } catch {
    /* Multipart uploads retain their exact source input below. */
  }
  const currentFields = optionalRecord(current) ?? {};
  const fields: PreviewField[] = [];
  const fieldIndexes = new Map<string, number>();
  const preview: ActionPreview = {
    proposalId: crypto.randomUUID(),
    version: 1,
    service: action.service,
    actionId: action.id,
    title: action.name,
    account:
      [connection?.profile.displayName, connection?.profile.accountId]
        .filter((value, index, all) => value && all.indexOf(value) === index)
        .join(" · ") ||
      connection?.connectionName ||
      "",
    kind: "generic",
    effect: "generic",
    fields,
    savedInput: input,
  };
  const add = (key: string, value: unknown, before?: unknown) => {
    if (value !== undefined) {
      const field = {
        key,
        value,
        before: before !== undefined && JSON.stringify(before) !== JSON.stringify(value) ? before : undefined,
      };
      const index = fieldIndexes.get(key);
      if (index !== undefined) fields[index] = field;
      else {
        fieldIndexes.set(key, fields.length);
        fields.push(field);
      }
    }
  };
  const deleted = request?.method === "DELETE";
  const trash =
    body.trashed === true ||
    body.in_trash === true ||
    body.archived === true ||
    (request && new URL(request.url).pathname.endsWith("/trash")) ||
    action.id === "notion.delete_block";
  if (deleted || trash) {
    preview.kind = "deletion";
    preview.effect = trash ? "trash" : "delete";
  }
  if (action.service === "gmail") {
    const message = optionalRecord(body.message);
    const raw = optionalString(body.raw) ?? optionalString(message?.raw);
    if (raw) {
      const mail = await simpleParser(Buffer.from(raw, "base64url"), { skipHtmlToText: true, skipTextToHtml: true });
      preview.kind = "email";
      preview.effect =
        action.id.includes("send") || action.id.includes("reply")
          ? "send"
          : action.id.includes("update")
            ? "update"
            : "create";
      add("from", mail.from?.text ?? preview.account);
      for (const key of ["to", "cc", "bcc"] as const) {
        const addresses = mail[key];
        add(key, Array.isArray(addresses) ? addresses.map((entry) => entry.text).join(", ") : (addresses?.text ?? ""));
      }
      add("subject", mail.subject ?? "");
      preview.body = mail.text;
      if (typeof mail.html === "string") preview.html = mail.html;
      preview.attachments = mail.attachments.map((file) => ({
        name: file.filename ?? "attachment",
        mimeType: file.contentType,
        size: file.size,
        contentBase64: file.content.toString("base64"),
      }));
      add("threadId", body.threadId ?? message?.threadId ?? original.threadId);
      add("draftId", body.id ?? original.draftId);
    }
  } else if (action.service === "googlecalendar" && request) {
    if (preview.kind !== "deletion") preview.kind = "calendar";
    if (preview.effect === "generic")
      preview.effect = request.method === "POST" && action.id !== "googlecalendar.move_event" ? "create" : "update";
    add("calendarId", original.calendarId ?? "primary");
    add("eventId", original.eventId);
    add("target", currentFields.summary);
    for (const [key, value] of Object.entries(body)) add(key, value, currentFields[key]);
    if (request) {
      const query = new URL(request.url).searchParams;
      add("sendUpdates", query.get("sendUpdates") ?? "none");
      for (const [key, value] of query) if (key !== "sendUpdates") add(key, value);
    }
  } else if ((action.service === "notion" || action.service === "googledrive") && request) {
    if (preview.kind !== "deletion") preview.kind = "document";
    if (preview.effect === "generic")
      preview.effect = action.id.includes("append")
        ? "append"
        : action.id.includes("create") || action.id === "googledrive.files.copy"
          ? "create"
          : "update";
    add("target", currentFields.name ?? currentFields.title ?? currentFields.properties);
    for (const key of ["fileId", "pageId", "blockId", "parents", "addParents", "removeParents"])
      add(key, original[key] ?? currentFields[key]);
    for (const [key, value] of Object.entries(body)) add(key, value, currentFields[key]);
    if (action.id === "notion.update_page_markdown") {
      preview.effect = body.type === "replace_content" ? "replace" : "update";
    }
    if (
      action.service === "googledrive" &&
      (typeof original.text === "string" || typeof original.contentBase64 === "string") &&
      action.id === "googledrive.files.update"
    )
      preview.effect = "replace";
    if (action.service === "notion") {
      if (typeof body.markdown === "string") preview.body = body.markdown;
      else if (Array.isArray(body.children)) preview.body = body.children.map(blockText).join("\n\n");
    }
    if (typeof original.text === "string") preview.body = original.text;
    if (typeof original.contentBase64 === "string") {
      const content = Buffer.from(original.contentBase64, "base64");
      preview.attachments = [
        {
          name: optionalString(original.name) ?? optionalString(currentFields.name) ?? "document",
          mimeType: optionalString(original.mimeType) ?? "application/octet-stream",
          size: content.length,
          contentBase64: content.toString("base64"),
        },
      ];
    }
  }
  if (fields.length === 0) for (const [key, value] of Object.entries(original)) add(key, value);
  if (request)
    add("preparedRequest", {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Object.keys(body).length > 0 ? body : bodyText,
    });
  return preview;
}

/** Resolve optional folder labels through the caller's existing connection and read policy. */
export async function resolvePreviewFolders(
  preview: ActionPreview,
  read: (fileId: string) => Promise<unknown>,
): Promise<void> {
  if (preview.service !== "googledrive") return;
  const folders = new Map<string, string[]>();
  for (const field of preview.fields) {
    if (!["parents", "addParents", "removeParents"].includes(field.key)) continue;
    const ids = Array.isArray(field.value) ? field.value : String(field.value ?? "").split(",");
    for (const value of ids) {
      const id = optionalString(value);
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      folders.set(id, [...(folders.get(id) ?? []), field.key]);
    }
  }
  const resolved = await Promise.all(
    [...folders].slice(0, 3).map(async ([id, keys]) => {
      try {
        const record = optionalRecord(await read(id));
        if (record?.id !== id || record?.mimeType !== "application/vnd.google-apps.folder") return [];
        return keys.map((key) => ({
          key,
          id,
          name: optionalString(record.name),
          url: `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`,
        }));
      } catch {
        return [];
      }
    }),
  );
  preview.resources = resolved.flat();
}
