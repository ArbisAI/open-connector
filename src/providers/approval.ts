import type { ExecutionResult } from "../core/types.ts";

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readBoundedResponseBytes } from "../core/request.ts";

const maxSnapshotBytes = 1024 * 1024;
const savedHeaders = ["content-type", "if-match", "if-none-match", "notion-version"];
const supportedActions = new Set([
  "gmail.send_email",
  "gmail.reply_email",
  "gmail.reply_to_thread",
  "gmail.create_draft",
  "gmail.create_email_draft",
  "gmail.update_draft",
  "gmail.send_draft",
  "gmail.delete_draft",
  "gmail.move_to_trash",
  "gmail.move_thread_to_trash",
  "googlecalendar.create_event",
  "googlecalendar.update_event",
  "googlecalendar.patch_event",
  "googlecalendar.delete_event",
  "googlecalendar.import_event",
  "googlecalendar.move_event",
  "googlecalendar.add_attendee",
  "googlecalendar.remove_attendee",
  "googledrive.files.create",
  "googledrive.files.update",
  "googledrive.files.delete",
  "googledrive.files.copy",
  "notion.append_block",
  "notion.append_block_children",
  "notion.create_page",
  "notion.update_page",
  "notion.update_page_markdown",
  "notion.update_block",
  "notion.delete_block",
  "notion.move_page",
]);

export interface SavedHttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

export interface SavedHttpRead {
  url: string;
  status: number;
  contentType: string;
  bodyBase64: string;
}

export interface PreparedAction {
  version: 1;
  actionId: string;
  connectionId: string;
  inputHash: string;
  request?: SavedHttpRequest;
  reads: SavedHttpRead[];
}

/** Validate the persisted wire format before replaying any provider request. */
export function isPreparedAction(value: unknown): value is PreparedAction {
  if (!value || typeof value !== "object") return false;
  const saved = value as PreparedAction;
  if (
    saved.version !== 1 ||
    typeof saved.actionId !== "string" ||
    typeof saved.connectionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.inputHash) ||
    !Array.isArray(saved.reads)
  )
    return false;
  const validBody = (body: unknown): body is string =>
    typeof body === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body);
  const validUrl = (url: unknown): boolean => {
    try {
      return typeof url === "string" && ["https:", "http:"].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  };
  let size = 0;
  for (const read of saved.reads) {
    if (
      !read ||
      !validUrl(read.url) ||
      !Number.isInteger(read.status) ||
      read.status < 200 ||
      read.status > 599 ||
      typeof read.contentType !== "string" ||
      !validBody(read.bodyBase64)
    )
      return false;
    size += Buffer.byteLength(read.bodyBase64, "base64");
  }
  const request = saved.request;
  if (request !== undefined) {
    if (!request || typeof request !== "object") return false;
    if (
      !validUrl(request.url) ||
      !["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ||
      !validBody(request.bodyBase64) ||
      !request.headers ||
      typeof request.headers !== "object" ||
      Array.isArray(request.headers)
    )
      return false;
    if (
      Object.entries(request.headers).some(([key, value]) => !savedHeaders.includes(key) || typeof value !== "string")
    )
      return false;
    size += Buffer.byteLength(request.bodyBase64, "base64");
  }
  return size <= maxSnapshotBytes;
}

export type ActionApproval = { mode: "prepare"; actionId: string } | { mode: "execute"; prepared: PreparedAction };

export class ApprovalPreparationError extends Error {
  readonly outcome: "not_executed" | "unknown";
  readonly code: string;
  constructor(message: string, outcome: "not_executed" | "unknown" = "not_executed", code = "approval_expired") {
    super(message);
    this.outcome = outcome;
    this.code = code;
  }
}

export function supportsPreparedAction(actionId: string): boolean {
  return supportedActions.has(actionId);
}

export function approvalInputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Run the real handler until its first write, without dispatching that write. */
export async function prepareHttpAction(
  run: (fetcher: typeof fetch) => Promise<unknown>,
  fetcher: typeof fetch,
): Promise<Pick<PreparedAction, "request" | "reads">> {
  let request: SavedHttpRequest | undefined;
  const reads: SavedHttpRead[] = [];
  let bytes = 0;
  let failure: ApprovalPreparationError | undefined;
  const snapshot = async (body: Response | Request): Promise<string> => {
    const buffer = Buffer.from(
      await readBoundedResponseBytes(body instanceof Response ? body : new Response(body.body), {
        maxBytes: maxSnapshotBytes - bytes,
        fieldName: "Complete approval",
        createError: (message) =>
          (failure = new ApprovalPreparationError(message, "not_executed", "approval_too_large")),
      }),
    );
    bytes += buffer.length;
    return buffer.toString("base64");
  };
  const capture = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (request) throw new ApprovalPreparationError("Approval preparation stopped before execution.");
    const next = new Request(url, init);
    if (next.method !== "GET" && next.method !== "HEAD") {
      const headers: Record<string, string> = {};
      for (const name of savedHeaders) {
        const value = next.headers.get(name);
        if (value != null) headers[name] = value;
      }
      request = { url: next.url, method: next.method, headers, bodyBase64: await snapshot(next) };
      throw new ApprovalPreparationError("Approval preparation stopped before execution.");
    }
    const response = await fetcher(url, init);
    reads.push({
      url: next.url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      bodyBase64: await snapshot(response.clone()),
    });
    return response;
  }) as typeof fetch;
  try {
    await run(capture);
  } catch (error) {
    if (failure) throw failure;
    if (!request) throw error;
  }
  if (!request) throw new ApprovalPreparationError("This action did not produce a reviewable write request.");
  return { request, reads };
}

/** Replay reviewed reads and send the frozen body with the current account credential. */
export function approvedHttpFetch(
  fetcher: typeof fetch,
  prepared: PreparedAction,
  onDenial?: (error: ApprovalPreparationError) => void,
): typeof fetch {
  let dispatched = false;
  const deny = (): never => {
    const error = new ApprovalPreparationError(
      "The action changed after review. Request a new approval.",
      dispatched ? "unknown" : "not_executed",
    );
    onDenial?.(error);
    throw error;
  };
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const next = new Request(url, init);
    next.signal.throwIfAborted();
    if (next.method === "GET" || next.method === "HEAD") {
      const saved = prepared.reads.find((read) => read.url === next.url);
      if (saved && !dispatched) {
        return new Response([204, 205, 304].includes(saved.status) ? null : Buffer.from(saved.bodyBase64, "base64"), {
          status: saved.status,
          headers: { "content-type": saved.contentType },
        });
      }
      if (!dispatched) deny();
      return fetcher(url, init);
    }
    const saved = prepared.request;
    if (dispatched || !saved || saved.url !== next.url || saved.method !== next.method) {
      return deny();
    }
    dispatched = true;
    const headers = new Headers(next.headers);
    headers.delete("content-length");
    for (const name of savedHeaders) {
      headers.delete(name);
      if (saved.headers[name] != null) headers.set(name, saved.headers[name]);
    }
    return fetcher(saved.url, {
      ...init,
      method: saved.method,
      headers,
      signal: next.signal,
      body: saved.method === "DELETE" && !saved.bodyBase64 ? undefined : Buffer.from(saved.bodyBase64, "base64"),
    });
  }) as typeof fetch;
}

/** Preserve an approval denial even when a provider wraps transport errors. */
export async function runApprovedHttpAction(
  run: (fetcher: typeof fetch) => Promise<unknown>,
  fetcher: typeof fetch,
  prepared: PreparedAction,
): Promise<unknown> {
  let denial: ApprovalPreparationError | undefined;
  try {
    const result = await run(
      approvedHttpFetch(fetcher, prepared, (error) => {
        denial = error;
      }),
    );
    if (denial) throw denial;
    return result;
  } catch (error) {
    throw denial ?? error;
  }
}

export function preparationFailure(error: ApprovalPreparationError): ExecutionResult {
  return {
    ok: false,
    error: {
      code: error.outcome === "unknown" ? "approval_outcome_unknown" : error.code,
      message: error.message,
      details: { outcome: error.outcome },
    },
  };
}
