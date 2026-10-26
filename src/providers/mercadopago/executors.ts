import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { IntegrationDefinition } from "../../triggers/common/integration.ts";
import type { PollDefinition } from "../../triggers/common/poll.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import { ProviderRequestError, defineBearerProviderExecutors, defineProviderProxy } from "../provider-runtime.ts";
import { mercadoPagoEvent } from "./trigger-on-event.ts";
import {
  asRecord,
  autoRecurringBody,
  compactBody,
  countryForSite,
  decimalAmount,
  decimalNumber,
  mercadoLibreApiBaseUrl,
  mercadoPagoApiBaseUrl,
  mercadoPagoRequest,
  moneyString,
  normalizeMerchantOrder,
  normalizePayment,
  normalizeRefund,
  normalizeSubscriptionInvoice,
  pagingOf,
  parseSettlementCsv,
  requireId,
  resultList,
  type MercadoPagoContext,
  type NormalizedPayment,
} from "./runtime.ts";

const service = "mercadopago";

type Handler = (input: Record<string, unknown>, context: MercadoPagoContext) => Promise<unknown>;

export const mercadoPagoActionHandlers: ProviderActionHandlers<"mercadopago", Handler> = {
  identify_account(_input, context) {
    return identify(context);
  },
  get_balance(_input, context) {
    return readBalance(context);
  },
  list_balance_transactions(input, context) {
    return listSettlementRows(input, context);
  },
  create_releases_report(input, context) {
    return createReport("release", input, context);
  },
  get_report_task(input, context) {
    return readReportTask(input, context);
  },
  create_customer(input, context) {
    return mutateCustomer("POST", "/v1/customers", input, context);
  },
  update_customer(input, context) {
    return mutateCustomer("PUT", `/v1/customers/${requireId(input.customerId, "customerId")}`, omit(input, ["customerId"]), context);
  },
  get_customer(input, context) {
    return readCustomer(`/v1/customers/${requireId(input.customerId, "customerId")}`, context);
  },
  search_customers(input, context) {
    return searchCustomers(input, context);
  },
  list_customers(input, context) {
    return searchCustomers(input, context);
  },
  async delete_customer(input, context) {
    const id = String(input.customerId ?? "");
    await mercadoPagoRequest(context, { method: "DELETE", path: `/v1/customers/${requireId(id, "customerId")}/delete` });
    return { deleted: true, id };
  },
  create_plan(input, context) {
    return createPlan(input, context);
  },
  async update_plan(input, context) {
    const plan = asRecord(
      await mercadoPagoRequest(context, {
        method: "PUT",
        path: `/preapproval_plan/${requireId(input.planId, "planId")}`,
        body: compactBody({
          reason: input.reason,
          auto_recurring: input.autoRecurring ? autoRecurringBody(input.autoRecurring) : undefined,
        }),
      }),
      "plan",
    );
    return { plan };
  },
  async get_plan(input, context) {
    return { plan: await mercadoPagoRequest(context, { method: "GET", path: `/preapproval_plan/${requireId(input.planId, "planId")}` }) };
  },
  search_plans(input, context) {
    return searchPlans(input, context);
  },
  async get_payment(input, context) {
    return { payment: await fetchPayment(String(input.paymentId ?? ""), context) };
  },
  search_payments(input, context) {
    return searchPayments(input, context);
  },
  async get_merchant_order(input, context) {
    return { order: normalizeMerchantOrder(await mercadoPagoRequest(context, { method: "GET", path: `/merchant_orders/${requireId(input.orderId, "orderId")}` })) };
  },
  search_merchant_orders(input, context) {
    return searchOrders(input, context, false);
  },
  list_open_merchant_orders(input, context) {
    return searchOrders({ ...input, status: "opened" }, context, true);
  },
  async get_subscription_invoice(input, context) {
    return { invoice: await fetchSubscriptionInvoice(String(input.invoiceId ?? ""), context) };
  },
  search_subscription_invoices(input, context) {
    return searchSubscriptionInvoices(input, context);
  },
  create_payment_link(input, context) {
    return createPaymentLink(input, context);
  },
  async get_payment_link(input, context) {
    const raw = asRecord(
      await mercadoPagoRequest(context, { method: "GET", path: `/checkout/preferences/${requireId(input.paymentLinkId, "paymentLinkId")}` }),
      "preference",
    );
    return preferenceLink(raw);
  },
  async search_payment_links(input, context) {
    const payload = await mercadoPagoRequest(context, {
      method: "GET",
      path: "/checkout/preferences/search",
      query: { external_reference: input.externalReference, limit: input.limit, offset: input.offset },
    });
    return { paymentLinks: resultList(payload), paging: pagingOf(payload) };
  },
  update_payment_link(input, context) {
    return updatePaymentLink(input, context);
  },
  create_subscription(input, context) {
    return createSubscription(input, context);
  },
  async get_subscription(input, context) {
    return {
      subscription: await mercadoPagoRequest(context, { method: "GET", path: `/preapproval/${requireId(input.subscriptionId, "subscriptionId")}` }),
    };
  },
  async update_subscription(input, context) {
    const subscription = await mercadoPagoRequest(context, {
      method: "PUT",
      path: `/preapproval/${requireId(input.subscriptionId, "subscriptionId")}`,
      body: compactBody({
        reason: input.reason,
        external_reference: input.externalReference,
        auto_recurring: input.autoRecurring ? autoRecurringBody(input.autoRecurring) : undefined,
      }),
    });
    return { subscription };
  },
  search_subscriptions(input, context) {
    return searchSubscriptions(input, context);
  },
  pause_subscription(input, context) {
    return setSubscriptionStatus(input, "paused", context);
  },
  cancel_subscription(input, context) {
    return setSubscriptionStatus(input, "cancelled", context);
  },
  async list_refunds(input, context) {
    const payload = await mercadoPagoRequest(context, { method: "GET", path: `/v1/payments/${requireId(input.paymentId, "paymentId")}/refunds` });
    return { refunds: Array.isArray(payload) ? payload : resultList(payload) };
  },
  async get_refund(input, context) {
    const raw = await mercadoPagoRequest(context, {
      method: "GET",
      path: `/v1/payments/${requireId(input.paymentId, "paymentId")}/refunds/${requireId(input.refundId, "refundId")}`,
    });
    return normalizeRefund(raw);
  },
  create_refund(input, context) {
    return createRefund(input, context);
  },
};

export const executors: ProviderExecutors = defineBearerProviderExecutors(service, mercadoPagoActionHandlers, {
  skipDnsValidation: true,
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: mercadoPagoApiBaseUrl,
  auth: { type: "bearer" },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher }) {
    return validateAccount(input.apiKey, fetcher);
  },
  async oauth2(input, { fetcher }) {
    return validateAccount(input.accessToken, fetcher);
  },
};

export const triggers: readonly (IntegrationDefinition | PollDefinition)[] = [mercadoPagoEvent];

async function validateAccount(accessToken: string, fetcher: typeof fetch) {
  const context: MercadoPagoContext = { accessToken, fetcher };
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(
      await mercadoPagoRequest(context, { method: "GET", path: "/users/me", baseUrl: mercadoLibreApiBaseUrl }),
      "account",
    );
  } catch (error) {
    if (error instanceof ProviderRequestError && (error.status === 401 || error.status === 403)) {
      throw new ProviderRequestError(400, "Mercado Pago access token was rejected.");
    }
    throw error;
  }
  const siteId = optionalString(payload.site_id) ?? "";
  if (siteId !== "MLM") {
    throw new ProviderRequestError(400, `This connector is for Mercado Pago Mexico (MLM). The token belongs to ${siteId || "an unknown site"}.`);
  }
  const id = payload.id == null ? "" : String(payload.id);
  const email = optionalString(payload.email);
  const nickname = optionalString(payload.nickname);
  return {
    profile: {
      accountId: id || "mercadopago",
      displayName: nickname || email || id || "Mercado Pago",
    },
    grantedScopes: [],
    metadata: { siteId, country: countryForSite(siteId), email: email ?? null },
  };
}

async function identify(context: MercadoPagoContext) {
  const payload = asRecord(
    await mercadoPagoRequest(context, { method: "GET", path: "/users/me", baseUrl: mercadoLibreApiBaseUrl }),
    "account",
  );
  const siteId = optionalString(payload.site_id) ?? "";
  if (siteId !== "MLM") {
    throw new ProviderRequestError(400, `This connector is for Mercado Pago Mexico (MLM). The account site is ${siteId || "unknown"}.`);
  }
  return {
    accountId: String(payload.id ?? ""),
    email: optionalString(payload.email) ?? null,
    nickname: optionalString(payload.nickname) ?? null,
    siteId,
    country: countryForSite(siteId),
  };
}

async function readBalance(context: MercadoPagoContext) {
  const account = await identify(context);
  try {
    const live = asRecord(
      await mercadoPagoRequest(context, {
        method: "GET",
        path: `/users/${encodeURIComponent(account.accountId)}/mercadopago_account/balance`,
      }),
      "balance",
    );
    if (live.available_balance !== undefined || live.total_amount !== undefined) {
      return {
        available: moneyString(live.available_balance),
        unavailable: moneyString(live.unavailable_balance),
        total: moneyString(live.total_amount),
        currency: optionalString(live.currency_id) ?? "MXN",
        source: "live",
        asOf: null,
      };
    }
  } catch (error) {
    if (!(error instanceof ProviderRequestError) || error.status !== 400) throw error;
  }
  const listed = await mercadoPagoRequest(context, { method: "GET", path: "/v1/account/release_report" });
  const rows = Array.isArray(listed) ? listed : resultList(listed);
  const latest = optionalRecord(rows[0]);
  if (!latest) {
    return { available: null, unavailable: null, total: null, currency: "MXN", source: "report", asOf: null };
  }
  return {
    available: moneyString(latest.available_balance ?? latest.total_amount),
    unavailable: moneyString(latest.unavailable_balance),
    total: moneyString(latest.total_amount ?? latest.available_balance),
    currency: optionalString(latest.currency_id) ?? "MXN",
    source: "report",
    asOf: optionalString(latest.date_created) ?? optionalString(latest.begin_date) ?? null,
  };
}

async function listSettlementRows(input: Record<string, unknown>, context: MercadoPagoContext) {
  const created = asRecord(
    await mercadoPagoRequest(context, {
      method: "POST",
      path: "/v1/account/settlement_report",
      body: { begin_date: input.beginDate, end_date: input.endDate },
    }),
    "settlement report",
  );
  const fileName = optionalString(created.file_name);
  const status = optionalString(created.status);
  if (!fileName || (status && status !== "processed" && status !== "enabled")) {
    return { ready: false, taskId: created.id == null ? null : String(created.id), transactions: [] };
  }
  const csv = await mercadoPagoRequest(context, {
    method: "GET",
    path: `/v1/account/settlement_report/${encodeURIComponent(fileName)}`,
    accept: "text/csv",
  });
  return {
    ready: true,
    taskId: created.id == null ? null : String(created.id),
    transactions: parseSettlementCsv(typeof csv === "string" ? csv : ""),
  };
}

async function createReport(kind: "release" | "settlement", input: Record<string, unknown>, context: MercadoPagoContext) {
  const created = asRecord(
    await mercadoPagoRequest(context, {
      method: "POST",
      path: `/v1/account/${kind === "release" ? "release_report" : "settlement_report"}`,
      body: { begin_date: input.beginDate, end_date: input.endDate },
    }),
    "report",
  );
  return { taskId: String(created.id ?? ""), status: optionalString(created.status) ?? null };
}

async function readReportTask(input: Record<string, unknown>, context: MercadoPagoContext) {
  const family = input.kind === "settlement" ? "settlement_report" : "release_report";
  const taskPayload = await mercadoPagoRequest(context, {
    method: "GET",
    path: `/v1/account/${family}/task/${requireId(input.taskId, "taskId")}`,
  });
  const task = Array.isArray(taskPayload) ? optionalRecord(taskPayload[0]) ?? {} : asRecord(taskPayload, "report task");
  const status = optionalString(task.status) ?? null;
  const fileName = optionalString(task.file_name) ?? null;
  return { taskId: String(task.id ?? input.taskId), status, ready: Boolean(fileName) || status === "processed", fileName };
}

async function mutateCustomer(method: "POST" | "PUT", path: string, input: Record<string, unknown>, context: MercadoPagoContext) {
  const customer = await mercadoPagoRequest(context, { method, path, body: customerBody(input) });
  return { customer };
}

async function readCustomer(path: string, context: MercadoPagoContext) {
  return { customer: await mercadoPagoRequest(context, { method: "GET", path }) };
}

function customerBody(input: Record<string, unknown>): Record<string, unknown> {
  return compactBody({
    email: input.email,
    first_name: input.first_name,
    last_name: input.last_name,
    phone: input.phone,
    identification: input.identification,
    address: input.address,
    description: input.description,
    metadata: input.metadata,
  });
}

async function searchCustomers(input: Record<string, unknown>, context: MercadoPagoContext) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/v1/customers/search",
    query: { email: input.email, limit: input.limit, offset: input.offset },
  });
  return { customers: resultList(payload), paging: pagingOf(payload) };
}

async function createPlan(input: Record<string, unknown>, context: MercadoPagoContext) {
  const raw = asRecord(
    await mercadoPagoRequest(context, {
      method: "POST",
      path: "/preapproval_plan",
      body: compactBody({
        reason: input.reason,
        auto_recurring: autoRecurringBody(input.autoRecurring),
        back_url: input.backUrl,
      }),
    }),
    "plan",
  );
  return {
    planId: String(raw.id ?? ""),
    status: optionalString(raw.status) ?? null,
    initPoint: optionalString(raw.init_point) ?? null,
    raw,
  };
}

async function searchPlans(input: Record<string, unknown>, context: MercadoPagoContext) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/preapproval_plan/search",
    query: { status: input.status, q: input.q, limit: input.limit, offset: input.offset },
  });
  return { plans: resultList(payload), paging: pagingOf(payload) };
}

async function fetchPayment(paymentId: string, context: MercadoPagoContext): Promise<NormalizedPayment> {
  return normalizePayment(
    await mercadoPagoRequest(context, { method: "GET", path: `/v1/payments/${requireId(paymentId, "paymentId")}` }),
  );
}

async function searchPayments(input: Record<string, unknown>, context: MercadoPagoContext) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/v1/payments/search",
    query: {
      status: input.status,
      external_reference: input.externalReference,
      begin_date: input.beginDate,
      end_date: input.endDate,
      range: input.range,
      "payer.id": input.payerId,
      sort: input.sort ?? "date_created",
      criteria: input.criteria ?? "desc",
      limit: input.limit,
      offset: input.offset,
    },
  });
  return { payments: resultList(payload).map((item) => normalizePayment(item)), paging: pagingOf(payload) };
}

async function searchOrders(input: Record<string, unknown>, context: MercadoPagoContext, openOnly: boolean) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/merchant_orders/search",
    query: {
      status: input.status,
      external_reference: input.externalReference,
      preference_id: input.preferenceId,
      limit: input.limit,
      offset: input.offset,
    },
  });
  const orders = resultList(payload).map((item) => normalizeMerchantOrder(item)).filter((order) => !openOnly || order.open);
  return { orders, paging: pagingOf(payload) };
}

async function fetchSubscriptionInvoice(invoiceId: string, context: MercadoPagoContext) {
  const raw = await mercadoPagoRequest(context, {
    method: "GET",
    path: `/authorized_payments/${requireId(invoiceId, "invoiceId")}`,
  });
  const nested = optionalRecord(optionalRecord(raw)?.payment);
  const paymentId = nested?.id;
  const linked = paymentId == null ? null : await fetchPayment(String(paymentId), context);
  return normalizeSubscriptionInvoice(raw, linked);
}

async function searchSubscriptionInvoices(input: Record<string, unknown>, context: MercadoPagoContext) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/authorized_payments",
    query: {
      preapproval_id: input.preapprovalId,
      payment_id: input.paymentId,
      payer_id: input.payerId,
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    },
  });
  const invoices = [];
  for (const item of resultList(payload)) {
    const nested = optionalRecord(optionalRecord(item)?.payment);
    const linked = nested?.id == null ? null : await fetchPayment(String(nested.id), context);
    invoices.push(normalizeSubscriptionInvoice(item, linked));
  }
  return { invoices, paging: pagingOf(payload) };
}

async function createPaymentLink(input: Record<string, unknown>, context: MercadoPagoContext) {
  const amount = decimalAmount(input.amount, "amount");
  const currency = String(input.currency ?? "");
  const description = String(input.description ?? "");
  const reference = String(input.externalReference ?? input.idempotencyKey ?? "");
  const existing = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/checkout/preferences/search",
    query: { external_reference: reference, limit: 1 },
  });
  const found = resultList(existing)[0];
  if (found) {
    const preference = asRecord(found, "preference");
    assertSameLink(preference, amount, description);
    return linkFromPreference(preference, amount, currency, reference);
  }
  const created = asRecord(
    await mercadoPagoRequest(context, {
      method: "POST",
      path: "/checkout/preferences",
      idempotencyKey: String(input.idempotencyKey ?? ""),
      body: compactBody({
        items: [{ title: description, quantity: 1, currency_id: currency, unit_price: decimalNumber(amount, "amount") }],
        payer: input.payerEmail ? { email: input.payerEmail } : undefined,
        external_reference: reference,
        metadata: input.metadata,
        expires: input.expiresAt ? true : undefined,
        expiration_date_to: input.expiresAt,
      }),
    }),
    "preference",
  );
  return linkFromPreference(created, amount, currency, reference);
}

function assertSameLink(preference: Record<string, unknown>, amount: string, description: string): void {
  const items = Array.isArray(preference.items) ? preference.items : [];
  const item = optionalRecord(items[0]) ?? {};
  const sameAmount = moneyString(item.unit_price) === amount;
  const sameTitle = optionalString(item.title) === description;
  if (!sameAmount || !sameTitle) {
    throw new ProviderRequestError(409, "A payment link with this idempotency key already exists for a different amount or description.");
  }
}

function linkFromPreference(preference: Record<string, unknown>, amount: string, currency: string, reference: string) {
  const url = optionalString(preference.init_point);
  if (!url) throw new ProviderRequestError(502, "Mercado Pago did not return a checkout URL.");
  return {
    paymentLinkId: String(preference.id ?? ""),
    url,
    sandboxUrl: optionalString(preference.sandbox_init_point) ?? null,
    externalReference: optionalString(preference.external_reference) ?? reference,
    amount,
    currency,
  };
}

function preferenceLink(preference: Record<string, unknown>) {
  return {
    paymentLinkId: String(preference.id ?? ""),
    url: optionalString(preference.init_point) ?? null,
    externalReference: optionalString(preference.external_reference) ?? null,
    raw: preference,
  };
}

async function updatePaymentLink(input: Record<string, unknown>, context: MercadoPagoContext) {
  const body = compactBody({
    items:
      input.amount || input.description
        ? [
            compactBody({
              title: input.description,
              quantity: 1,
              currency_id: input.currency,
              unit_price: input.amount ? decimalNumber(input.amount, "amount") : undefined,
            }),
          ]
        : undefined,
    expiration_date_to: input.expiresAt,
  });
  const raw = asRecord(
    await mercadoPagoRequest(context, {
      method: "PUT",
      path: `/checkout/preferences/${requireId(input.paymentLinkId, "paymentLinkId")}`,
      body,
    }),
    "preference",
  );
  return { paymentLinkId: String(raw.id ?? input.paymentLinkId), url: optionalString(raw.init_point) ?? null, raw };
}

async function createSubscription(input: Record<string, unknown>, context: MercadoPagoContext) {
  if (!input.planId && !input.autoRecurring) {
    throw new ProviderRequestError(400, "create_subscription requires planId or autoRecurring.");
  }
  const raw = asRecord(
    await mercadoPagoRequest(context, {
      method: "POST",
      path: "/preapproval",
      body: compactBody({
        reason: input.reason,
        payer_email: input.payerEmail,
        preapproval_plan_id: input.planId,
        auto_recurring: input.autoRecurring ? autoRecurringBody(input.autoRecurring) : undefined,
        external_reference: input.externalReference,
        back_url: input.backUrl,
      }),
    }),
    "subscription",
  );
  return {
    subscriptionId: String(raw.id ?? ""),
    status: optionalString(raw.status) ?? null,
    authorizationUrl: optionalString(raw.init_point) ?? null,
    raw,
  };
}

async function searchSubscriptions(input: Record<string, unknown>, context: MercadoPagoContext) {
  const payload = await mercadoPagoRequest(context, {
    method: "GET",
    path: "/preapproval/search",
    query: {
      status: input.status,
      payer_email: input.payerEmail,
      preapproval_plan_id: input.planId,
      q: input.q,
      limit: input.limit,
      offset: input.offset,
    },
  });
  return { subscriptions: resultList(payload), paging: pagingOf(payload) };
}

async function setSubscriptionStatus(input: Record<string, unknown>, status: "paused" | "cancelled", context: MercadoPagoContext) {
  const raw = asRecord(
    await mercadoPagoRequest(context, {
      method: "PUT",
      path: `/preapproval/${requireId(input.subscriptionId, "subscriptionId")}`,
      body: { status },
    }),
    "subscription",
  );
  return { subscriptionId: String(raw.id ?? input.subscriptionId), status: optionalString(raw.status) ?? status };
}

async function createRefund(input: Record<string, unknown>, context: MercadoPagoContext) {
  const body = input.amount === undefined ? {} : { amount: decimalNumber(input.amount, "amount") };
  const raw = await mercadoPagoRequest(context, {
    method: "POST",
    path: `/v1/payments/${requireId(input.paymentId, "paymentId")}/refunds`,
    body,
    idempotencyKey: String(input.idempotencyKey ?? ""),
  });
  const refund = normalizeRefund(raw);
  return {
    refundId: refund.refundId,
    paymentId: refund.paymentId || String(input.paymentId),
    amount: refund.amount,
    status: refund.status,
    approved: refund.approved,
  };
}

function omit(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const skipped = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !skipped.has(key)));
}
