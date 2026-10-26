import type { ProviderFetch } from "../provider-runtime.ts";

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { mercadoPagoActionHandlers, credentialValidators } from "./executors.ts";
import { mercadoPagoEvent, parseSignature } from "./trigger-on-event.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  json: Record<string, unknown> | null;
  query: URLSearchParams;
}

type Route = (request: RecordedRequest) => { status?: number; body: unknown; contentType?: string };

const token = "APP_USR-fixture-token";

function createFetcher(routes: Record<string, Route>): { fetcher: ProviderFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher: ProviderFetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const json = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const request: RecordedRequest = {
      url: url.toString(),
      method: init?.method ?? "GET",
      headers,
      json,
      query: url.searchParams,
    };
    requests.push(request);
    const route = routes[`${request.method} ${url.origin}${url.pathname}`];
    if (!route) {
      return new Response(JSON.stringify({ message: "no route", status: 404 }), { status: 404 });
    }
    const { status = 200, body, contentType = "application/json" } = route(request);
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, { status, headers: { "content-type": contentType } });
  };
  return { fetcher, requests };
}

const me = {
  id: 1001,
  email: "tienda@example.mx",
  nickname: "TIENDA",
  site_id: "MLM",
};

function context(routes: Record<string, Route>) {
  const created = createFetcher(routes);
  return { ...created, accessToken: token };
}

const accountRoute: Route = () => ({ body: me });

describe("identify_account", () => {
  it("maps an MLM users/me response and sends the bearer token", async () => {
    const { fetcher, requests, accessToken } = context({ "GET https://api.mercadolibre.com/users/me": accountRoute });
    const result = await mercadoPagoActionHandlers.identify_account({}, { accessToken, fetcher });
    expect(result).toEqual({
      accountId: "1001",
      email: "tienda@example.mx",
      nickname: "TIENDA",
      siteId: "MLM",
      country: "MX",
    });
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(requests[0]?.url).toBe("https://api.mercadolibre.com/users/me");
  });
});

describe("credential validator", () => {
  it("accepts MLM and rejects other sites without a second call", async () => {
    const mexico = createFetcher({ "GET https://api.mercadolibre.com/users/me": accountRoute });
    const profile = await credentialValidators.apiKey!({ apiKey: token, values: {} }, { fetcher: mexico.fetcher });
    expect(profile.profile).toMatchObject({ accountId: "1001", displayName: "TIENDA" });
    expect(mexico.requests).toHaveLength(1);

    const argentina = createFetcher({
      "GET https://api.mercadolibre.com/users/me": () => ({ body: { ...me, site_id: "MLA" } }),
    });
    await expect(credentialValidators.apiKey!({ apiKey: token, values: {} }, { fetcher: argentina.fetcher })).rejects.toMatchObject({
      status: 400,
    });
    expect(argentina.requests).toHaveLength(1);

    const brazil = createFetcher({
      "GET https://api.mercadolibre.com/users/me": () => ({ body: { ...me, site_id: "MLB" } }),
    });
    await expect(
      credentialValidators.oauth2!(
        { authType: "oauth2", accessToken: token, tokenType: "Bearer", profile: { displayName: "x" }, metadata: {} },
        { fetcher: brazil.fetcher },
      ),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("get_balance", () => {
  it("maps a live balance fixture", async () => {
    const { fetcher, accessToken } = context({
      "GET https://api.mercadolibre.com/users/me": accountRoute,
      "GET https://api.mercadopago.com/users/1001/mercadopago_account/balance": () => ({
        body: { available_balance: 1250.5, unavailable_balance: 10, total_amount: 1260.5, currency_id: "MXN" },
      }),
    });
    await expect(mercadoPagoActionHandlers.get_balance({}, { accessToken, fetcher })).resolves.toEqual({
      available: "1250.50",
      unavailable: "10.00",
      total: "1260.50",
      currency: "MXN",
      source: "live",
      asOf: null,
    });
  });

  it("falls through to a releases report on 404 and does not invent zeros", async () => {
    const { fetcher, accessToken } = context({
      "GET https://api.mercadolibre.com/users/me": accountRoute,
      "GET https://api.mercadopago.com/users/1001/mercadopago_account/balance": () => ({
        status: 404,
        body: { message: "not found", status: 404 },
      }),
      "GET https://api.mercadopago.com/v1/account/release_report": () => ({
        body: [{ date_created: "2026-03-01T00:00:00.000Z", available_balance: 80.25, currency_id: "MXN" }],
      }),
    });
    await expect(mercadoPagoActionHandlers.get_balance({}, { accessToken, fetcher })).resolves.toMatchObject({
      available: "80.25",
      source: "report",
      asOf: "2026-03-01T00:00:00.000Z",
    });
  });
});

describe("settlement rows", () => {
  it("parses a documented CSV and returns no rows while processing", async () => {
    const processing = context({
      "POST https://api.mercadopago.com/v1/account/settlement_report": () => ({
        body: { id: "task-1", status: "processing" },
      }),
    });
    await expect(
      mercadoPagoActionHandlers.list_balance_transactions(
        { beginDate: "2026-03-01", endDate: "2026-03-02" },
        { accessToken: token, fetcher: processing.fetcher },
      ),
    ).resolves.toEqual({ ready: false, taskId: "task-1", transactions: [] });

    const ready = context({
      "POST https://api.mercadopago.com/v1/account/settlement_report": () => ({
        body: { id: "task-2", status: "processed", file_name: "settlement.csv" },
      }),
      "GET https://api.mercadopago.com/v1/account/settlement_report/settlement.csv": () => ({
        contentType: "text/csv",
        body: "SOURCE_ID,TRANSACTION_TYPE,TRANSACTION_AMOUNT,FEE_AMOUNT,SETTLEMENT_NET_AMOUNT,SETTLEMENT_DATE,CURRENCY_ID\n99,SETTLEMENT,1250.50,25.00,1225.50,2026-03-01T00:00:00Z,MXN\n",
      }),
    });
    const result = await mercadoPagoActionHandlers.list_balance_transactions(
      { beginDate: "2026-03-01", endDate: "2026-03-02" },
      { accessToken: token, fetcher: ready.fetcher },
    );
    expect(result).toMatchObject({
      ready: true,
      transactions: [{ sourceId: "99", type: "SETTLEMENT", gross: "1250.50", fee: "25.00", net: "1225.50", currency: "MXN" }],
    });
  });
});

describe("customers", () => {
  it("searches by exact email and reads paging", async () => {
    const { fetcher, requests, accessToken } = context({
      "GET https://api.mercadopago.com/v1/customers/search": () => ({
        body: { paging: { total: 1, limit: 10, offset: 0 }, results: [{ id: "cus-1", email: "juan@example.com" }] },
      }),
    });
    const result = await mercadoPagoActionHandlers.search_customers(
      { email: "juan@example.com", limit: 10 },
      { accessToken, fetcher },
    );
    expect(result).toMatchObject({ paging: { total: 1 }, customers: [{ id: "cus-1" }] });
    expect(requests[0]?.query.get("email")).toBe("juan@example.com");
  });

  it("posts RFC identification and surfaces cause descriptions", async () => {
    const happy = context({
      "POST https://api.mercadopago.com/v1/customers": (request) => ({
        body: { id: "cus-2", ...request.json },
      }),
    });
    await mercadoPagoActionHandlers.create_customer(
      { email: "ana@example.mx", identification: { type: "RFC", number: "XAXX010101000" } },
      { accessToken: token, fetcher: happy.fetcher },
    );
    expect(happy.requests[0]?.json).toMatchObject({ identification: { type: "RFC", number: "XAXX010101000" } });

    const failed = context({
      "POST https://api.mercadopago.com/v1/customers": () => ({
        status: 400,
        body: { message: "invalid customer", cause: [{ description: "email already exists" }] },
      }),
    });
    await expect(
      mercadoPagoActionHandlers.create_customer({ email: "ana@example.mx" }, { accessToken: token, fetcher: failed.fetcher }),
    ).rejects.toThrow(/email already exists/);
  });

  it("updates and gets by path id, and deletes at the /delete path", async () => {
    const routes = context({
      "PUT https://api.mercadopago.com/v1/customers/cus-9": () => ({ body: { id: "cus-9" } }),
      "GET https://api.mercadopago.com/v1/customers/cus-9": () => ({ body: { id: "cus-9" } }),
      "DELETE https://api.mercadopago.com/v1/customers/cus-9/delete": () => ({ body: {} }),
    });
    await mercadoPagoActionHandlers.update_customer({ customerId: "cus-9", first_name: "Ana" }, { accessToken: token, fetcher: routes.fetcher });
    await mercadoPagoActionHandlers.get_customer({ customerId: "cus-9" }, { accessToken: token, fetcher: routes.fetcher });
    await mercadoPagoActionHandlers.delete_customer({ customerId: "cus-9" }, { accessToken: token, fetcher: routes.fetcher });
    expect(routes.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "PUT /v1/customers/cus-9",
      "GET /v1/customers/cus-9",
      "DELETE /v1/customers/cus-9/delete",
    ]);
    expect(routes.requests[0]?.json).toEqual({ first_name: "Ana" });
  });
});

const approvedCard = {
  id: 555,
  status: "approved",
  status_detail: "accredited",
  payment_method_id: "visa",
  payment_type_id: "credit_card",
  transaction_amount: 1250.5,
  transaction_amount_refunded: 0,
  currency_id: "MXN",
  description: "Factura 0042",
  external_reference: "ref-1",
  date_created: "2026-03-01T12:00:00.000Z",
  date_approved: "2026-03-01T12:01:00.000Z",
  payer: { email: "maria@example.mx" },
  transaction_details: {},
};

describe("payments", () => {
  it("normalizes an approved card without marking it pending", async () => {
    const { fetcher, accessToken } = context({
      "GET https://api.mercadopago.com/v1/payments/555": () => ({ body: approvedCard }),
    });
    const result = await mercadoPagoActionHandlers.get_payment({ paymentId: "555" }, { accessToken, fetcher });
    expect(result).toMatchObject({
      payment: { id: "555", status: "approved", paid: true, pending: false, transactionAmount: "1250.50", currency: "MXN" },
    });
  });

  it("keeps OXXO and SPEI pending and exposes the ticket URL", async () => {
    const oxxo = context({
      "GET https://api.mercadopago.com/v1/payments/1": () => ({
        body: {
          ...approvedCard,
          id: 1,
          status: "pending",
          status_detail: "pending_waiting_payment",
          payment_method_id: "oxxo",
          payment_type_id: "ticket",
          date_approved: null,
          transaction_details: { external_resource_url: "https://www.mercadopago.com.mx/payments/1/ticket" },
        },
      }),
    });
    const oxxoResult = await mercadoPagoActionHandlers.get_payment({ paymentId: "1" }, { accessToken: token, fetcher: oxxo.fetcher });
    expect(oxxoResult).toMatchObject({
      payment: { paid: false, pending: true, ticketUrl: "https://www.mercadopago.com.mx/payments/1/ticket", paymentMethodId: "oxxo" },
    });

    const spei = context({
      "GET https://api.mercadopago.com/v1/payments/2": () => ({
        body: {
          ...approvedCard,
          id: 2,
          status: "pending",
          payment_method_id: "clabe",
          payment_type_id: "bank_transfer",
          transaction_details: { external_resource_url: "https://www.mercadopago.com.mx/payments/2/spei" },
        },
      }),
    });
    const speiResult = await mercadoPagoActionHandlers.get_payment({ paymentId: "2" }, { accessToken: token, fetcher: spei.fetcher });
    expect(speiResult).toMatchObject({ payment: { paid: false, pending: true, paymentTypeId: "bank_transfer" } });
  });

  it.each(["in_process", "rejected", "refunded", "charged_back"])("does not collapse %s into approved", async (status) => {
    const { fetcher } = context({
      "GET https://api.mercadopago.com/v1/payments/9": () => ({ body: { ...approvedCard, status } }),
    });
    const result = await mercadoPagoActionHandlers.get_payment({ paymentId: "9" }, { accessToken: token, fetcher });
    expect(result).toMatchObject({ payment: { status, paid: false } });
  });

  it("fills required sort and forwards documented query names", async () => {
    const { fetcher, requests } = context({
      "GET https://api.mercadopago.com/v1/payments/search": () => ({ body: { results: [], paging: { total: 0, limit: 0, offset: 0 } } }),
    });
    const result = await mercadoPagoActionHandlers.search_payments(
      { externalReference: "ref-1", beginDate: "NOW-7DAYS", endDate: "NOW", range: "date_created" },
      { accessToken: token, fetcher },
    );
    expect(result).toMatchObject({ payments: [] });
    expect(requests[0]?.query.get("sort")).toBe("date_created");
    expect(requests[0]?.query.get("criteria")).toBe("desc");
    expect(requests[0]?.query.get("external_reference")).toBe("ref-1");
    expect(requests[0]?.query.get("begin_date")).toBe("NOW-7DAYS");

    const custom = context({
      "GET https://api.mercadopago.com/v1/payments/search": () => ({ body: { results: [], paging: { total: 0, limit: 0, offset: 0 } } }),
    });
    await mercadoPagoActionHandlers.search_payments({ sort: "date_approved", criteria: "asc" }, { accessToken: token, fetcher: custom.fetcher });
    expect(custom.requests[0]?.query.get("sort")).toBe("date_approved");
    expect(custom.requests[0]?.query.get("criteria")).toBe("asc");
  });
});

describe("payment links", () => {
  const input = {
    amount: "1250.50",
    currency: "MXN",
    description: "Factura 0042",
    idempotencyKey: "nexo-plink-7-mo:1",
  };

  it("posts a decimal unit price and maps init_point", async () => {
    const { fetcher, requests } = context({
      "GET https://api.mercadopago.com/checkout/preferences/search": () => ({ body: { elements: [], paging: { total: 0, limit: 1, offset: 0 } } }),
      "POST https://api.mercadopago.com/checkout/preferences": () => ({
        body: {
          id: "pref-1",
          init_point: "https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref-1",
          sandbox_init_point: "https://sandbox.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref-1",
          external_reference: input.idempotencyKey,
        },
      }),
    });
    const result = await mercadoPagoActionHandlers.create_payment_link(input, { accessToken: token, fetcher });
    expect(result).toMatchObject({
      paymentLinkId: "pref-1",
      url: "https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref-1",
      amount: "1250.50",
    });
    expect(requests[1]?.json).toMatchObject({
      items: [{ title: "Factura 0042", quantity: 1, unit_price: 1250.5, currency_id: "MXN" }],
      external_reference: input.idempotencyKey,
    });
    expect(requests[1]?.headers["x-idempotency-key"]).toBe(input.idempotencyKey);
    expect(requests).toHaveLength(2);
  });

  it("returns the existing link for the same key and amount, and conflicts on a different amount", async () => {
    const same = context({
      "GET https://api.mercadopago.com/checkout/preferences/search": () => ({
        body: {
          elements: [{ id: "pref-1", init_point: "https://www.mercadopago.com.mx/checkout/start", items: [{ title: "Factura 0042", unit_price: 1250.5 }] }],
        },
      }),
    });
    await mercadoPagoActionHandlers.create_payment_link(input, { accessToken: token, fetcher: same.fetcher });
    expect(same.requests.some((request) => request.method === "POST")).toBe(false);

    const different = context({
      "GET https://api.mercadopago.com/checkout/preferences/search": () => ({
        body: { elements: [{ id: "pref-1", init_point: "https://example.test", items: [{ title: "Factura 0042", unit_price: 10 }] }] },
      }),
    });
    await expect(mercadoPagoActionHandlers.create_payment_link(input, { accessToken: token, fetcher: different.fetcher })).rejects.toBeInstanceOf(
      ProviderRequestError,
    );
    expect(different.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects centavos locally before any fetch", async () => {
    const { fetcher, requests } = context({});
    await expect(
      mercadoPagoActionHandlers.create_payment_link({ ...input, amount: "125000" }, { accessToken: token, fetcher }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0);
  });

  it("updates with PUT", async () => {
    const { fetcher, requests } = context({
      "PUT https://api.mercadopago.com/checkout/preferences/pref-1": () => ({
        body: { id: "pref-1", init_point: "https://www.mercadopago.com.mx/checkout/start" },
      }),
    });
    await mercadoPagoActionHandlers.update_payment_link(
      { paymentLinkId: "pref-1", amount: "1000.00", currency: "MXN", description: "Factura 0042" },
      { accessToken: token, fetcher },
    );
    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.json).toMatchObject({ items: [{ unit_price: 1000 }] });
  });
});

describe("merchant orders and subscription invoices", () => {
  it("computes amount due for open and partial orders", async () => {
    const { fetcher } = context({
      "GET https://api.mercadopago.com/merchant_orders/10": () => ({
        body: { id: 10, status: "opened", total_amount: 1250.5, paid_amount: 0, currency_id: "MXN" },
      }),
    });
    await expect(mercadoPagoActionHandlers.get_merchant_order({ orderId: "10" }, { accessToken: token, fetcher })).resolves.toMatchObject({
      order: { open: true, amountDue: "1250.50", paidAmount: "0.00" },
    });

    const partial = context({
      "GET https://api.mercadopago.com/merchant_orders/11": () => ({
        body: { id: 11, status: "opened", total_amount: 1250.5, paid_amount: 250, currency_id: "MXN" },
      }),
    });
    await expect(
      mercadoPagoActionHandlers.get_merchant_order({ orderId: "11" }, { accessToken: token, fetcher: partial.fetcher }),
    ).resolves.toMatchObject({ order: { amountDue: "1000.50", open: true } });

    const closed = context({
      "GET https://api.mercadopago.com/merchant_orders/12": () => ({
        body: { id: 12, status: "closed", total_amount: 100, paid_amount: 100 },
      }),
    });
    await expect(
      mercadoPagoActionHandlers.get_merchant_order({ orderId: "12" }, { accessToken: token, fetcher: closed.fetcher }),
    ).resolves.toMatchObject({ order: { open: false, amountDue: "0.00" } });
  });

  it("maps a missing order to invalid input", async () => {
    const { fetcher } = context({
      "GET https://api.mercadopago.com/merchant_orders/404": () => ({ status: 404, body: { message: "merchant order not found", status: 404 } }),
    });
    await expect(mercadoPagoActionHandlers.get_merchant_order({ orderId: "404" }, { accessToken: token, fetcher })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("keeps a scheduled bill open and checks the linked payment when processed", async () => {
    const scheduled = context({
      "GET https://api.mercadopago.com/authorized_payments/7": () => ({
        body: { id: 7, status: "scheduled", transaction_amount: 200, currency_id: "MXN", preapproval_id: "sub-1" },
      }),
    });
    await expect(
      mercadoPagoActionHandlers.get_subscription_invoice({ invoiceId: "7" }, { accessToken: token, fetcher: scheduled.fetcher }),
    ).resolves.toMatchObject({ invoice: { open: true, paid: false } });

    const processed = context({
      "GET https://api.mercadopago.com/authorized_payments/8": () => ({
        body: { id: 8, status: "processed", payment: { id: 555 }, transaction_amount: 200, currency_id: "MXN" },
      }),
      "GET https://api.mercadopago.com/v1/payments/555": () => ({ body: approvedCard }),
    });
    await expect(
      mercadoPagoActionHandlers.get_subscription_invoice({ invoiceId: "8" }, { accessToken: token, fetcher: processed.fetcher }),
    ).resolves.toMatchObject({ invoice: { paid: true, open: false, paymentStatus: "approved" } });

    const waiting = context({
      "GET https://api.mercadopago.com/authorized_payments/9": () => ({
        body: { id: 9, status: "processed", payment: { id: 3 } },
      }),
      "GET https://api.mercadopago.com/v1/payments/3": () => ({ body: { ...approvedCard, id: 3, status: "pending" } }),
    });
    await expect(
      mercadoPagoActionHandlers.get_subscription_invoice({ invoiceId: "9" }, { accessToken: token, fetcher: waiting.fetcher }),
    ).resolves.toMatchObject({ invoice: { paid: false, open: true, paymentStatus: "pending" } });
  });
});

describe("plans and subscriptions", () => {
  it("posts decimal recurring terms and returns an authorization URL distinct from a checkout url", async () => {
    const plan = context({
      "POST https://api.mercadopago.com/preapproval_plan": (request) => ({
        body: { id: "plan-1", status: "active", init_point: "https://www.mercadopago.com.mx/subscriptions/plan-1", echo: request.json },
      }),
    });
    await mercadoPagoActionHandlers.create_plan(
      {
        reason: "Mensual",
        autoRecurring: { frequency: 1, frequency_type: "months", transaction_amount: "199.00", currency_id: "MXN" },
      },
      { accessToken: token, fetcher: plan.fetcher },
    );
    expect(plan.requests[0]?.json).toMatchObject({
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 199, currency_id: "MXN" },
    });

    const subscription = context({
      "POST https://api.mercadopago.com/preapproval": () => ({
        body: { id: "sub-1", status: "pending", init_point: "https://www.mercadopago.com.mx/subscriptions/authorize" },
      }),
    });
    const created = await mercadoPagoActionHandlers.create_subscription(
      { reason: "Mensual", payerEmail: "ana@example.mx", planId: "plan-1" },
      { accessToken: token, fetcher: subscription.fetcher },
    );
    expect(created).toMatchObject({ authorizationUrl: "https://www.mercadopago.com.mx/subscriptions/authorize" });
    expect(created).not.toHaveProperty("url");
  });

  it("pauses and cancels by sending only status", async () => {
    const { fetcher, requests } = context({
      "PUT https://api.mercadopago.com/preapproval/sub-1": (request) => ({ body: { id: "sub-1", status: request.json?.status } }),
    });
    await mercadoPagoActionHandlers.pause_subscription({ subscriptionId: "sub-1" }, { accessToken: token, fetcher });
    await mercadoPagoActionHandlers.cancel_subscription({ subscriptionId: "sub-1" }, { accessToken: token, fetcher });
    expect(requests[0]?.json).toEqual({ status: "paused" });
    expect(requests[1]?.json).toEqual({ status: "cancelled" });
  });
});

describe("refunds", () => {
  it("omits amount for a full refund and sends the idempotency header twice", async () => {
    const { fetcher, requests } = context({
      "POST https://api.mercadopago.com/v1/payments/555/refunds": () => ({
        body: { id: 90, payment_id: 555, amount: 1250.5, status: "approved" },
      }),
    });
    const input = { paymentId: "555", idempotencyKey: "refund-1" };
    await mercadoPagoActionHandlers.create_refund(input, { accessToken: token, fetcher });
    await mercadoPagoActionHandlers.create_refund(input, { accessToken: token, fetcher });
    expect(requests[0]?.json).toEqual({});
    expect(requests[0]?.headers["x-idempotency-key"]).toBe("refund-1");
    expect(requests[1]?.headers["x-idempotency-key"]).toBe("refund-1");
  });

  it("sends a decimal partial amount and does not treat in_process as approved", async () => {
    const { fetcher, requests } = context({
      "POST https://api.mercadopago.com/v1/payments/555/refunds": () => ({
        body: { id: 91, payment_id: 555, amount: 10, status: "in_process" },
      }),
    });
    const result = await mercadoPagoActionHandlers.create_refund(
      { paymentId: "555", idempotencyKey: "refund-2", amount: "10.00" },
      { accessToken: token, fetcher },
    );
    expect(requests[0]?.json).toEqual({ amount: 10 });
    expect(result).toMatchObject({ status: "in_process", approved: false, amount: "10.00" });
  });
});

describe("errors", () => {
  it("maps auth, rate limit, and server failures without echoing the token", async () => {
    const unauthorized = context({
      "GET https://api.mercadolibre.com/users/me": () => ({ status: 401, body: { message: `bad ${token}` } }),
    });
    await expect(mercadoPagoActionHandlers.identify_account({}, { accessToken: token, fetcher: unauthorized.fetcher })).rejects.toMatchObject({
      status: 401,
    });
    await expect(mercadoPagoActionHandlers.identify_account({}, { accessToken: token, fetcher: unauthorized.fetcher })).rejects.not.toThrow(token);

    const limited = context({
      "GET https://api.mercadolibre.com/users/me": () => ({ status: 429, body: { message: "too many" } }),
    });
    await expect(mercadoPagoActionHandlers.identify_account({}, { accessToken: token, fetcher: limited.fetcher })).rejects.toMatchObject({
      status: 429,
    });

    const down = context({
      "GET https://api.mercadolibre.com/users/me": () => ({ status: 500, body: "<html>down</html>" }),
    });
    await expect(mercadoPagoActionHandlers.identify_account({}, { accessToken: token, fetcher: down.fetcher })).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("webhook signature", () => {
  const secret = "whsec-fixture";
  const resourceId = "555";
  const requestId = "req-1";
  const ts = "1710000000";
  const manifest = `id:${resourceId};request-id:${requestId};ts:${ts};`;
  const signature = createHmac("sha256", secret).update(manifest).digest("hex");

  function receive(header: string, body: unknown = { id: 1, type: "payment", action: "payment.updated", data: { id: resourceId }, payment: { status: "approved" } }) {
    return mercadoPagoEvent.receive({
      admit: true,
      bindingId: "binding",
      callbackSecret: secret,
      config: { topics: ["payment"] },
      connector: {} as never,
      current: true,
      header: (name) => (name === "x-signature" ? header : name === "x-request-id" ? requestId : undefined),
      method: "POST",
      now: new Date(),
      payload: body as never,
      query: (name) => (name === "data.id" ? resourceId : undefined),
      rawBody: new Uint8Array(),
    });
  }

  it("accepts the documented manifest and ignores a nested payment object", async () => {
    const event = await receive(`ts=${ts},v1=${signature}`);
    expect(event).toMatchObject({
      outcome: "event",
      outputs: { topic: "payment", action: "payment.updated", notificationId: "1", resourceId, liveMode: false },
    });
    expect(event.outcome === "event" ? event.outputs : {}).not.toHaveProperty("payment");
  });

  it("rejects a wrong secret, a missing header, and a body signature", async () => {
    await expect(receive(`ts=${ts},v1=${"0".repeat(64)}`)).resolves.toMatchObject({ outcome: "respond", status: 401 });
    await expect(receive("")).resolves.toMatchObject({ outcome: "respond", status: 401 });
    const bodySignature = createHmac("sha256", secret).update(JSON.stringify({ id: 1 })).digest("hex");
    await expect(receive(`ts=${ts},v1=${bodySignature}`)).resolves.toMatchObject({ outcome: "respond", status: 401 });
    expect(parseSignature(`ts=${ts},v1=${signature}`)).toEqual({ ts, v1: signature });
  });
});
