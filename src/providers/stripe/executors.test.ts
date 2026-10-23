import type { ProviderFetch } from "../provider-runtime.ts";

import { describe, expect, it } from "vitest";
import { ProviderRequestError } from "../provider-runtime.ts";
import { stripeActions } from "./actions.ts";
import { stripeActionHandlers } from "./executors.ts";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

type Route = (request: RecordedRequest) => { status?: number; body: unknown };

function createFetcher(routes: Record<string, Route>): { fetcher: ProviderFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetcher: ProviderFetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const form = Object.fromEntries(new URLSearchParams(typeof init?.body === "string" ? init.body : "").entries());
    const request: RecordedRequest = { url, method: init?.method ?? "GET", headers, form };
    requests.push(request);
    const route = routes[`${request.method} ${url.split("?")[0]}`];
    if (!route) {
      return new Response(JSON.stringify({ error: { message: "no route" } }), { status: 404 });
    }
    const { status = 200, body } = route(request);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetcher, requests };
}

const apiKey = "sk_test_fixture";
const priceRoute: Route = (request) => ({
  body: {
    id: "price_123",
    object: "price",
    unit_amount: Number(request.form.unit_amount),
    currency: request.form.currency,
  },
});
const linkRoute: Route = () => ({
  body: { id: "plink_123", object: "payment_link", url: "https://buy.stripe.com/test_abc", active: true },
});
const happyRoutes = {
  "POST https://api.stripe.com/v1/prices": priceRoute,
  "POST https://api.stripe.com/v1/payment_links": linkRoute,
};
const validInput = {
  amount: 125000,
  currency: "MXN",
  description: "Invoice 0042",
  idempotencyKey: "nexo-plink-company7-inv0042",
};

describe("stripe create_payment_link", () => {
  it("is declared as a write action with an integer minor-unit amount and a required idempotency key", () => {
    const definition = stripeActions.find((action) => action.name === "create_payment_link");
    expect(definition?.operationType).toBe("write");
    const schema = definition?.inputSchema as {
      properties: Record<string, { type?: string; minimum?: number }>;
      required: string[];
    };
    expect(schema.properties.amount.type).toBe("integer");
    expect(schema.properties.amount.minimum).toBe(1);
    expect(schema.required).toEqual(expect.arrayContaining(["amount", "currency", "description", "idempotencyKey"]));
  });

  it("creates a one-off price for the exact amount in minor units, then a single-use payment link", async () => {
    const { fetcher, requests } = createFetcher(happyRoutes);
    const result = await stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher });

    expect(requests).toHaveLength(2);
    const [price, link] = requests;
    expect(price.form).toMatchObject({
      currency: "mxn",
      unit_amount: "125000",
      "product_data[name]": "Invoice 0042",
    });
    expect(link.form).toMatchObject({
      "line_items[0][price]": "price_123",
      "line_items[0][quantity]": "1",
      "restrictions[completed_sessions][limit]": "1",
    });
    expect(result).toEqual({
      paymentLinkId: "plink_123",
      url: "https://buy.stripe.com/test_abc",
      priceId: "price_123",
      amount: 125000,
      currency: "mxn",
      active: true,
    });
  });

  it("sends a stable, distinct Stripe idempotency key on each request so a retry creates nothing new", async () => {
    const { fetcher, requests } = createFetcher(happyRoutes);
    await stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher });
    await stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher });

    const keys = requests.map((request) => request.headers["idempotency-key"]);
    expect(keys).toEqual([
      "nexo-plink-company7-inv0042:price",
      "nexo-plink-company7-inv0042:link",
      "nexo-plink-company7-inv0042:price",
      "nexo-plink-company7-inv0042:link",
    ]);
  });

  it("forwards metadata to the payment link so a payment can be matched to its invoice", async () => {
    const { fetcher, requests } = createFetcher(happyRoutes);
    await stripeActionHandlers.create_payment_link(
      { ...validInput, metadata: { nexo_invoice_ref: "inv_0042" } },
      { apiKey, fetcher },
    );
    expect(requests[1].form["metadata[nexo_invoice_ref]"]).toBe("inv_0042");
  });

  it.each([
    ["a fractional amount", { amount: 1250.5 }],
    ["a zero amount", { amount: 0 }],
    ["a negative amount", { amount: -5 }],
    ["an amount sent as a string", { amount: "1250" }],
    ["a currency that is not three letters", { currency: "pesos" }],
    ["an empty description", { description: "  " }],
    ["a missing idempotency key", { idempotencyKey: "" }],
  ])("rejects %s before calling Stripe", async (_label, override) => {
    const { fetcher, requests } = createFetcher(happyRoutes);
    await expect(
      stripeActionHandlers.create_payment_link({ ...validInput, ...override }, { apiKey, fetcher }),
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0);
  });

  it("maps a Stripe idempotency conflict to 409 and creates no link", async () => {
    const { fetcher, requests } = createFetcher({
      "POST https://api.stripe.com/v1/prices": () => ({
        status: 400,
        body: {
          error: {
            type: "idempotency_error",
            message: "Keys for idempotent requests can only be used with the same parameters",
          },
        },
      }),
      "POST https://api.stripe.com/v1/payment_links": linkRoute,
    });
    const error = await stripeActionHandlers
      .create_payment_link(validInput, { apiKey, fetcher })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderRequestError);
    expect((error as ProviderRequestError).status).toBe(409);
    expect(requests).toHaveLength(1);
  });

  it("maps an invalid key to 401 and a Stripe outage to 502", async () => {
    const unauthorized = createFetcher({
      "POST https://api.stripe.com/v1/prices": () => ({ status: 401, body: { error: { message: "Invalid API Key" } } }),
    });
    await expect(
      stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher: unauthorized.fetcher }),
    ).rejects.toMatchObject({ status: 401 });

    const outage = createFetcher({
      "POST https://api.stripe.com/v1/prices": priceRoute,
      "POST https://api.stripe.com/v1/payment_links": () => ({ status: 503, body: { error: { message: "down" } } }),
    });
    await expect(
      stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher: outage.fetcher }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("fails with 502 when Stripe returns a link without a URL", async () => {
    const { fetcher } = createFetcher({
      ...happyRoutes,
      "POST https://api.stripe.com/v1/payment_links": () => ({ body: { id: "plink_123", object: "payment_link" } }),
    });
    await expect(stripeActionHandlers.create_payment_link(validInput, { apiKey, fetcher })).rejects.toMatchObject({
      status: 502,
    });
  });
});

describe("stripe invoice reads", () => {
  it("lists open invoices with status and due-date filters", async () => {
    const { fetcher, requests } = createFetcher({
      "GET https://api.stripe.com/v1/invoices": () => ({
        body: { object: "list", url: "/v1/invoices", has_more: false, data: [{ id: "in_1", status: "open" }] },
      }),
    });
    const result = await stripeActionHandlers.list_invoices(
      { status: "open", due_date: { lt: 1_760_000_000 }, limit: 50 },
      { apiKey, fetcher },
    );
    const query = new URL(requests[0].url).searchParams;
    expect(query.get("status")).toBe("open");
    expect(query.get("due_date[lt]")).toBe("1760000000");
    expect(query.get("limit")).toBe("50");
    expect(result).toEqual({
      invoices: { object: "list", url: "/v1/invoices", has_more: false, data: [{ id: "in_1", status: "open" }] },
    });
  });

  it("retrieves one invoice by id", async () => {
    const { fetcher, requests } = createFetcher({
      "GET https://api.stripe.com/v1/invoices/in_1": () => ({ body: { id: "in_1", status: "paid" } }),
    });
    const result = await stripeActionHandlers.get_invoice({ invoiceId: "in_1" }, { apiKey, fetcher });
    expect(requests[0].method).toBe("GET");
    expect(result).toEqual({ invoice: { id: "in_1", status: "paid" } });
  });

  it("declares invoice and balance reads as read actions and offers no refund or charge-creation action", () => {
    const names = new Map(stripeActions.map((action) => [action.name, action.operationType]));
    expect(names.get("list_invoices")).toBe("read");
    expect(names.get("get_invoice")).toBe("read");
    expect(names.get("search_invoices")).toBe("read");
    expect(names.get("get_balance")).toBe("read");
    expect(names.get("list_balance_transactions")).toBe("read");
    expect(names.get("list_charges")).toBe("read");
    expect([...names.keys()].some((name) => /refund|create_charge|payment_intent/.test(name))).toBe(false);
  });
});

describe("stripe balance and charge reads", () => {
  it("reads the account balance from Stripe", async () => {
    const { fetcher, requests } = createFetcher({
      "GET https://api.stripe.com/v1/balance": () => ({
        body: {
          object: "balance",
          available: [{ amount: 4200, currency: "usd" }],
          pending: [{ amount: 800, currency: "usd" }],
        },
      }),
    });
    const result = await stripeActionHandlers.get_balance({}, { apiKey, fetcher });
    expect(requests[0].method).toBe("GET");
    expect(result).toEqual({
      balance: {
        object: "balance",
        available: [{ amount: 4200, currency: "usd" }],
        pending: [{ amount: 800, currency: "usd" }],
      },
      available: [{ amount: 4200, currency: "usd" }],
      pending: [{ amount: 800, currency: "usd" }],
    });
  });

  it("lists charges without creating one", async () => {
    const { fetcher, requests } = createFetcher({
      "GET https://api.stripe.com/v1/charges": () => ({
        body: { object: "list", url: "/v1/charges", has_more: false, data: [{ id: "ch_1", amount: 4200 }] },
      }),
    });
    const result = await stripeActionHandlers.list_charges({ customer: "cus_1", limit: 10 }, { apiKey, fetcher });
    const query = new URL(requests[0].url).searchParams;
    expect(requests[0].method).toBe("GET");
    expect(query.get("customer")).toBe("cus_1");
    expect(query.get("limit")).toBe("10");
    expect(result).toEqual({
      charges: { object: "list", url: "/v1/charges", has_more: false, data: [{ id: "ch_1", amount: 4200 }] },
    });
  });
});
