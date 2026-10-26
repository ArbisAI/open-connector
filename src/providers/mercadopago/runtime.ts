import type { ProviderFetch } from "../provider-runtime.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";

export const mercadoPagoApiBaseUrl = "https://api.mercadopago.com";
export const mercadoLibreApiBaseUrl = "https://api.mercadolibre.com";

const siteCountry: Record<string, string> = {
  MLM: "MX",
  MLA: "AR",
  MLB: "BR",
  MLC: "CL",
  MCO: "CO",
  MPE: "PE",
  MLU: "UY",
};

export interface MercadoPagoContext {
  accessToken: string;
  fetcher: ProviderFetch;
  signal?: AbortSignal;
}

export interface MercadoPagoRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown> | undefined;
  idempotencyKey?: string;
  baseUrl?: string;
  accept?: string;
}

export function decimalAmount(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !/^\d+\.\d{2}$/.test(value)) {
    throw new ProviderRequestError(
      400,
      `${fieldName} must be a decimal string with two fraction digits, for example 1250.50. Do not send centavos.`,
    );
  }
  return value;
}

export function decimalNumber(value: unknown, fieldName: string): number {
  return Number(decimalAmount(value, fieldName));
}

export function moneyString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed.toFixed(2);
  }
  return null;
}

export function requireId(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return encodeURIComponent(value.trim());
}

export function countryForSite(siteId: string): string {
  return siteCountry[siteId] ?? siteId;
}

export async function mercadoPagoRequest(context: MercadoPagoContext, request: MercadoPagoRequest): Promise<unknown> {
  const url = new URL(`${request.baseUrl ?? mercadoPagoApiBaseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.accessToken}`,
    accept: request.accept ?? "application/json",
    "user-agent": providerUserAgent,
  };
  if (request.idempotencyKey) headers["x-idempotency-key"] = request.idempotencyKey;
  let body: string | undefined;
  if (request.body) {
    body = JSON.stringify(request.body);
    headers["content-type"] = "application/json";
  }
  const response = await context.fetcher(url.toString(), {
    method: request.method,
    headers,
    ...(body ? { body } : {}),
    signal: context.signal,
  });
  if (!response.ok) {
    throw await mapMercadoPagoError(response);
  }
  if (response.status === 204) return {};
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/csv") || request.accept === "text/csv") {
    return response.text();
  }
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function mapMercadoPagoError(response: Response): Promise<ProviderRequestError> {
  const parsed = await readErrorBody(response);
  const message = parsed.message || `Mercado Pago request failed with status ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return new ProviderRequestError(response.status, scrubToken(message));
  }
  if (response.status === 429) {
    return new ProviderRequestError(429, scrubToken(message) || "Mercado Pago rate limit exceeded");
  }
  if (response.status === 404 || response.status === 400 || response.status === 409) {
    return new ProviderRequestError(response.status === 409 ? 409 : 400, scrubToken(message));
  }
  return new ProviderRequestError(502, scrubToken(message), response.status);
}

async function readErrorBody(response: Response): Promise<{ message: string }> {
  try {
    const payload = optionalRecord(await response.clone().json());
    const causes = Array.isArray(payload?.cause) ? payload.cause : [];
    const descriptions = causes
      .map((cause) => optionalString(optionalRecord(cause)?.description))
      .filter((item): item is string => Boolean(item));
    const message = optionalString(payload?.message) ?? optionalString(payload?.error);
    const combined = [message, ...descriptions].filter(Boolean).join(": ");
    if (combined) return { message: combined };
  } catch {
    // Mercado Pago can return HTML or an empty body.
  }
  const text = await response.text().catch(() => "");
  return { message: text.trim() };
}

function scrubToken(message: string): string {
  return message.replace(/APP_USR-[A-Za-z0-9-]+/g, "[redacted]").replace(/TEST-[A-Za-z0-9-]+/g, "[redacted]");
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) throw new ProviderRequestError(502, `Mercado Pago ${label} response was not an object`);
  return record;
}

export function resultList(payload: unknown): unknown[] {
  const record = optionalRecord(payload);
  const list = record?.results ?? record?.elements ?? record?.data;
  return Array.isArray(list) ? list : Array.isArray(payload) ? payload : [];
}

export function pagingOf(payload: unknown): { total: number; limit: number; offset: number } {
  const paging = optionalRecord(optionalRecord(payload)?.paging) ?? {};
  return {
    total: numberOrZero(paging.total),
    limit: numberOrZero(paging.limit),
    offset: numberOrZero(paging.offset),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface NormalizedPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  pending: boolean;
  paid: boolean;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
  transactionAmount: string | null;
  amountRefunded: string | null;
  currency: string | null;
  description: string | null;
  externalReference: string | null;
  dateCreated: string | null;
  dateApproved: string | null;
  moneyReleaseDate: string | null;
  payerEmail: string | null;
  ticketUrl: string | null;
  raw: Record<string, unknown>;
}

export function normalizePayment(value: unknown): NormalizedPayment {
  const raw = asRecord(value, "payment");
  const status = optionalString(raw.status) ?? "pending";
  const details = optionalRecord(raw.transaction_details) ?? {};
  const payer = optionalRecord(raw.payer) ?? {};
  return {
    id: String(raw.id ?? ""),
    status,
    statusDetail: optionalString(raw.status_detail) ?? null,
    pending: status !== "approved",
    paid: status === "approved",
    paymentMethodId: optionalString(raw.payment_method_id) ?? null,
    paymentTypeId: optionalString(raw.payment_type_id) ?? null,
    transactionAmount: moneyString(raw.transaction_amount),
    amountRefunded: moneyString(raw.transaction_amount_refunded),
    currency: optionalString(raw.currency_id) ?? null,
    description: optionalString(raw.description) ?? null,
    externalReference: optionalString(raw.external_reference) ?? null,
    dateCreated: optionalString(raw.date_created) ?? null,
    dateApproved: optionalString(raw.date_approved) ?? null,
    moneyReleaseDate: optionalString(raw.money_release_date) ?? null,
    payerEmail: optionalString(payer.email) ?? null,
    ticketUrl: optionalString(details.external_resource_url) ?? null,
    raw,
  };
}

export interface NormalizedOrder {
  id: string;
  status: string;
  open: boolean;
  externalReference: string | null;
  preferenceId: string | null;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  currency: string;
  payerEmail: string | null;
  dateCreated: string | null;
  raw: Record<string, unknown>;
}

export function normalizeMerchantOrder(value: unknown): NormalizedOrder {
  const raw = asRecord(value, "merchant order");
  const total = Number(moneyString(raw.total_amount) ?? "0");
  const paid = Number(moneyString(raw.paid_amount) ?? "0");
  const due = Math.max(0, Math.round((total - paid) * 100) / 100);
  const status = optionalString(raw.status) ?? "opened";
  const payer = optionalRecord(raw.payer) ?? {};
  return {
    id: String(raw.id ?? ""),
    status,
    open: status === "opened" && due > 0,
    externalReference: optionalString(raw.external_reference) ?? null,
    preferenceId: optionalString(raw.preference_id) ?? null,
    totalAmount: total.toFixed(2),
    paidAmount: paid.toFixed(2),
    amountDue: due.toFixed(2),
    currency: optionalString(raw.currency_id) ?? "MXN",
    payerEmail: optionalString(payer.email) ?? null,
    dateCreated: optionalString(raw.date_created) ?? null,
    raw,
  };
}

export interface NormalizedSubscriptionInvoice {
  id: string;
  preapprovalId: string | null;
  status: string;
  open: boolean;
  paid: boolean;
  transactionAmount: string | null;
  currency: string | null;
  paymentId: string | null;
  paymentStatus: string | null;
  dateCreated: string | null;
  raw: Record<string, unknown>;
}

export function normalizeSubscriptionInvoice(
  value: unknown,
  linkedPayment?: NormalizedPayment | null,
): NormalizedSubscriptionInvoice {
  const raw = asRecord(value, "subscription invoice");
  const status = optionalString(raw.status) ?? "scheduled";
  const nested = optionalRecord(raw.payment);
  const paymentId = nested?.id != null ? String(nested.id) : null;
  const paymentStatus = linkedPayment?.status ?? optionalString(nested?.status) ?? null;
  const paid = status === "processed" && paymentStatus === "approved";
  const open = status === "scheduled" || status === "recycling" || (status === "processed" && !paid);
  return {
    id: String(raw.id ?? ""),
    preapprovalId: optionalString(raw.preapproval_id) ?? null,
    status,
    open,
    paid,
    transactionAmount: moneyString(raw.transaction_amount),
    currency: optionalString(raw.currency_id) ?? null,
    paymentId,
    paymentStatus,
    dateCreated: optionalString(raw.date_created) ?? null,
    raw,
  };
}

export function normalizeRefund(value: unknown): {
  refundId: string;
  paymentId: string;
  amount: string | null;
  status: string | null;
  approved: boolean;
  raw: Record<string, unknown>;
} {
  const raw = asRecord(value, "refund");
  const status = optionalString(raw.status) ?? null;
  return {
    refundId: String(raw.id ?? ""),
    paymentId: String(raw.payment_id ?? ""),
    amount: moneyString(raw.amount),
    status,
    approved: status === "approved",
    raw,
  };
}

export function compactBody(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function autoRecurringBody(value: unknown): Record<string, unknown> {
  const record = asRecord(value, "autoRecurring");
  return compactBody({
    frequency: record.frequency,
    frequency_type: record.frequency_type,
    transaction_amount: decimalNumber(record.transaction_amount, "autoRecurring.transaction_amount"),
    currency_id: record.currency_id,
    repetitions: record.repetitions,
    free_trial: record.free_trial,
  });
}

/**
 * Settlement and releases CSVs use overlapping column names. Map either set.
 * Columns follow the account-money and released-money report field lists.
 */
export function parseSettlementCsv(csv: string): Array<{
  date: string | null;
  type: string | null;
  gross: string | null;
  fee: string | null;
  net: string | null;
  currency: string | null;
  sourceId: string | null;
}> {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsv(lines[0] ?? "").map((cell) => cell.trim().toUpperCase());
  const index = (names: string[]): number => names.map((name) => header.indexOf(name)).find((found) => found >= 0) ?? -1;
  const date = index(["SETTLEMENT_DATE", "TRANSACTION_DATE", "DATE"]);
  const type = index(["TRANSACTION_TYPE", "RECORD_TYPE"]);
  const gross = index(["TRANSACTION_AMOUNT", "GROSS_AMOUNT"]);
  const fee = index(["FEE_AMOUNT", "MP_FEE_AMOUNT"]);
  const net = index(["SETTLEMENT_NET_AMOUNT", "NET_CREDIT_AMOUNT"]);
  const currency = index(["CURRENCY_ID", "CURRENCY"]);
  const source = index(["SOURCE_ID"]);
  return lines.slice(1, 501).map((line) => {
    const cells = splitCsv(line);
    const cell = (at: number) => (at >= 0 ? cells[at]?.trim() || null : null);
    return {
      date: cell(date),
      type: cell(type),
      gross: moneyString(cell(gross)),
      fee: moneyString(cell(fee)),
      net: moneyString(cell(net)),
      currency: cell(currency),
      sourceId: cell(source),
    };
  });
}

function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}
