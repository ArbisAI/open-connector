import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { IntegrationDefinition } from "../../triggers/common/integration.ts";
import type { PollDefinition } from "../../triggers/common/poll.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { ApiKeyProviderContext } from "../provider-runtime.ts";

import { compactObject, optionalRecord, optionalString } from "../../core/cast.ts";
import {
  ProviderRequestError,
  defineApiKeyProviderExecutors,
  defineProviderProxy,
  providerUserAgent,
  requiredResponseRecord,
} from "../provider-runtime.ts";
import { stripeEvent } from "./trigger-on-event.ts";

type StripeActionContext = ApiKeyProviderContext;

type StripeActionHandler = (input: Record<string, unknown>, context: StripeActionContext) => Promise<unknown>;

interface StripeRequestInput {
  apiKey: string;
  fetcher: typeof fetch;
  method: "GET" | "POST" | "DELETE";
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

const service = "stripe";
const stripeApiBaseUrl = "https://api.stripe.com";
const stripeApiVersion = "2024-06-20";
const stripeAccountPath = "/v1/account";

export const stripeActionHandlers: ProviderActionHandlers<"stripe", StripeActionHandler> = {
  identify_account(_input, context) {
    return executeIdentifyAccount(context);
  },
  create_customer(input, context) {
    return executeCustomerMutation("/v1/customers", input, context);
  },
  update_customer(input, context) {
    return executeCustomerMutation(
      `/v1/customers/${encodeStripePath(input.customerId, "customerId")}`,
      omitKeys(input, ["customerId"]),
      context,
    );
  },
  get_customer(input, context) {
    return executeCustomerRead(`/v1/customers/${encodeStripePath(input.customerId, "customerId")}`, context);
  },
  list_customers(input, context) {
    return executeStripeList("/v1/customers", "customers", input, context);
  },
  search_customers(input, context) {
    return executeStripeList("/v1/customers/search", "customers", input, context);
  },
  delete_customer(input, context) {
    return executeStripeDelete(`/v1/customers/${encodeStripePath(input.customerId, "customerId")}`, context);
  },
  create_product(input, context) {
    return executeProductMutation("/v1/products", input, context);
  },
  update_product(input, context) {
    return executeProductMutation(
      `/v1/products/${encodeStripePath(input.productId, "productId")}`,
      omitKeys(input, ["productId"]),
      context,
    );
  },
  get_product(input, context) {
    return executeProductRead(`/v1/products/${encodeStripePath(input.productId, "productId")}`, context);
  },
  list_products(input, context) {
    return executeStripeList("/v1/products", "products", input, context);
  },
  search_products(input, context) {
    return executeStripeList("/v1/products/search", "products", input, context);
  },
  delete_product(input, context) {
    return executeStripeDelete(`/v1/products/${encodeStripePath(input.productId, "productId")}`, context);
  },
  create_price(input, context) {
    if (input.product === undefined && input.product_data === undefined) {
      throw new ProviderRequestError(400, "create_price requires product or product_data");
    }
    if (
      input.unit_amount === undefined &&
      input.unit_amount_decimal === undefined &&
      input.custom_unit_amount === undefined
    ) {
      throw new ProviderRequestError(400, "create_price requires unit_amount or unit_amount_decimal");
    }
    if (
      input.custom_unit_amount !== undefined &&
      (input.unit_amount !== undefined || input.unit_amount_decimal !== undefined)
    ) {
      throw new ProviderRequestError(
        400,
        "create_price custom_unit_amount cannot be used with unit_amount or unit_amount_decimal",
      );
    }
    return executePriceMutation("/v1/prices", input, context);
  },
  update_price(input, context) {
    return executePriceMutation(
      `/v1/prices/${encodeStripePath(input.priceId, "priceId")}`,
      omitKeys(input, ["priceId"]),
      context,
    );
  },
  get_price(input, context) {
    return executePriceRead(`/v1/prices/${encodeStripePath(input.priceId, "priceId")}`, context);
  },
  list_prices(input, context) {
    return executeStripeList("/v1/prices", "prices", input, context);
  },
  search_prices(input, context) {
    return executeStripeList("/v1/prices/search", "prices", input, context);
  },
  list_invoices(input, context) {
    return executeStripeList("/v1/invoices", "invoices", input, context);
  },
  get_invoice(input, context) {
    return executeInvoiceRead(`/v1/invoices/${encodeStripePath(input.invoiceId, "invoiceId")}`, context);
  },
  create_payment_link(input, context) {
    return executeCreatePaymentLink(input, context);
  },
};

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, stripeActionHandlers);

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: stripeApiBaseUrl,
  auth: { type: "api_key_authorization", prefix: "Bearer " },
  skipDnsValidation: true,
  customizeRequest({ headers }) {
    if (!headers.has("stripe-version")) headers.set("stripe-version", stripeApiVersion);
  },
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher }) {
    const profile = await validateStripeCredential(input.apiKey, fetcher);
    return profile;
  },
};

async function validateStripeCredential(
  apiKey: string,
  fetcher: typeof fetch,
): Promise<{
  profile: {
    accountId?: string;
    displayName: string;
  };
  grantedScopes: string[];
  metadata: Record<string, unknown>;
}> {
  const payload = requiredResponseRecord(
    await stripeRequest(stripeAccountPath, {
      apiKey,
      fetcher,
      method: "GET",
    }),
    "stripe account response",
  );
  const accountId = optionalString(payload.id);
  const email = optionalString(payload.email);
  const country = optionalString(payload.country);
  const defaultCurrency = optionalString(payload.default_currency);

  return {
    profile: {
      accountId,
      displayName: email ?? accountId ?? "Stripe API Key",
    },
    grantedScopes: [],
    metadata: compactObject({
      apiBaseUrl: stripeApiBaseUrl,
      apiVersion: stripeApiVersion,
      validationEndpoint: stripeAccountPath,
      accountId,
      email,
      country,
      defaultCurrency,
    }),
  };
}

async function executeIdentifyAccount(context: StripeActionContext) {
  const payload = requiredResponseRecord(
    await stripeRequest(stripeAccountPath, {
      apiKey: context.apiKey,
      fetcher: context.fetcher,
      method: "GET",
    }),
    "stripe account response",
  );

  return {
    account: payload,
    accountId: optionalString(payload.id) ?? null,
    email: optionalString(payload.email) ?? null,
    country: optionalString(payload.country) ?? null,
    defaultCurrency: optionalString(payload.default_currency) ?? null,
  };
}

async function executeCustomerMutation(path: string, input: Record<string, unknown>, context: StripeActionContext) {
  const customer = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "POST",
    body: input,
  });
  return { customer: optionalRecord(customer) ?? null };
}

async function executeCustomerRead(path: string, context: StripeActionContext) {
  const customer = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "GET",
  });
  return { customer: optionalRecord(customer) ?? null };
}

async function executeProductMutation(path: string, input: Record<string, unknown>, context: StripeActionContext) {
  const product = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "POST",
    body: input,
  });
  return { product: optionalRecord(product) ?? null };
}

async function executeProductRead(path: string, context: StripeActionContext) {
  const product = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "GET",
  });
  return { product: optionalRecord(product) ?? null };
}

async function executePriceMutation(path: string, input: Record<string, unknown>, context: StripeActionContext) {
  const price = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "POST",
    body: input,
  });
  return { price: optionalRecord(price) ?? null };
}

async function executePriceRead(path: string, context: StripeActionContext) {
  const price = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "GET",
  });
  return { price: optionalRecord(price) ?? null };
}

async function executeInvoiceRead(path: string, context: StripeActionContext) {
  const invoice = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "GET",
  });
  return { invoice: optionalRecord(invoice) ?? null };
}

/**
 * One exact amount, one link. Stripe payment links price from a Price object,
 * so the link is created in two idempotent steps: a one-off price for the
 * amount, then a single-use link for that price. Both requests derive their
 * Stripe idempotency key from the caller's key, so a retry after a lost
 * response returns the same price and the same link.
 */
async function executeCreatePaymentLink(input: Record<string, unknown>, context: StripeActionContext) {
  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1) {
    throw new ProviderRequestError(400, "amount must be a positive integer in the smallest currency unit");
  }
  const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "";
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new ProviderRequestError(400, "currency must be a three-letter ISO code");
  }
  const description = optionalString(input.description)?.trim() ?? "";
  if (!description) {
    throw new ProviderRequestError(400, "description is required");
  }
  const idempotencyKey = optionalString(input.idempotencyKey)?.trim() ?? "";
  if (!idempotencyKey) {
    throw new ProviderRequestError(400, "idempotencyKey is required");
  }
  const metadata = optionalRecord(input.metadata) ?? {};

  const price = requiredResponseRecord(
    await stripeRequest("/v1/prices", {
      apiKey: context.apiKey,
      fetcher: context.fetcher,
      method: "POST",
      idempotencyKey: `${idempotencyKey}:price`,
      body: { currency, unit_amount: amount, product_data: { name: description }, metadata },
    }),
    "stripe price response",
  );
  const priceId = optionalString(price.id);
  if (!priceId) {
    throw new ProviderRequestError(502, "Stripe returned a price without an id");
  }
  const link = requiredResponseRecord(
    await stripeRequest("/v1/payment_links", {
      apiKey: context.apiKey,
      fetcher: context.fetcher,
      method: "POST",
      idempotencyKey: `${idempotencyKey}:link`,
      body: {
        line_items: [{ price: priceId, quantity: 1 }],
        restrictions: { completed_sessions: { limit: 1 } },
        metadata,
      },
    }),
    "stripe payment link response",
  );
  const paymentLinkId = optionalString(link.id);
  const url = optionalString(link.url);
  if (!paymentLinkId || !url) {
    throw new ProviderRequestError(502, "Stripe returned a payment link without an id or url");
  }
  return {
    paymentLinkId,
    url,
    priceId,
    amount,
    currency,
    active: link.active !== false,
  };
}

async function executeStripeList(
  path: string,
  outputKey: "customers" | "products" | "prices" | "invoices",
  input: Record<string, unknown>,
  context: StripeActionContext,
) {
  const payload = await stripeRequest(path, {
    apiKey: context.apiKey,
    fetcher: context.fetcher,
    method: "GET",
    query: input,
  });
  return { [outputKey]: requiredResponseRecord(payload, "stripe list response") };
}

async function executeStripeDelete(path: string, context: StripeActionContext) {
  const payload = requiredResponseRecord(
    await stripeRequest(path, {
      apiKey: context.apiKey,
      fetcher: context.fetcher,
      method: "DELETE",
    }),
    "stripe delete response",
  );
  return {
    deleted: payload.deleted === true,
    object: optionalString(payload.object) ?? "unknown",
    id: optionalString(payload.id) ?? "unknown",
    raw: payload,
  };
}

async function stripeRequest(path: string, input: StripeRequestInput): Promise<unknown> {
  const url = new URL(`${stripeApiBaseUrl}${path}`);
  appendStripeParams(url.searchParams, input.query);

  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "stripe-version": stripeApiVersion,
    "user-agent": providerUserAgent,
  };
  if (input.idempotencyKey) {
    headers["idempotency-key"] = input.idempotencyKey;
  }

  let body: string | undefined;
  if (input.body) {
    const params = new URLSearchParams();
    appendStripeParams(params, input.body);
    body = params.toString();
    headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8";
  }

  const response = await input.fetcher(url.toString(), {
    method: input.method,
    headers,
    ...(body ? { body } : {}),
  });

  if (!response.ok) {
    throw mapStripeError(response.status, await readStripeError(response));
  }

  if (response.status === 204) {
    return {};
  }

  return response.json() as Promise<unknown>;
}

function appendStripeParams(params: URLSearchParams, value: unknown, prefix?: string): void {
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      // Stripe addresses object list entries by index (line_items[0][price]).
      const itemPrefix = item !== null && typeof item === "object" && prefix ? `${prefix}[${index}]` : prefix;
      appendStripeParams(params, item, itemPrefix);
    });
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      appendStripeParams(params, child, prefix ? `${prefix}[${key}]` : key);
    }
    return;
  }

  if (!prefix) {
    return;
  }

  params.append(prefix, String(value));
}

function encodeStripePath(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderRequestError(400, `${fieldName} is required`);
  }
  return encodeURIComponent(value);
}

function omitKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key)));
}

interface StripeErrorBody {
  message: string;
  type?: string;
}

async function readStripeError(response: Response): Promise<StripeErrorBody> {
  try {
    const payload = optionalRecord(await response.json());
    const error = optionalRecord(payload?.error);
    const message = optionalString(error?.message);
    if (message) {
      return { message, type: optionalString(error?.type) };
    }
  } catch {
    // Stripe can return HTML or an empty body for edge errors.
  }

  const text = await response.text().catch(() => "");
  return { message: text.trim() || `Stripe request failed with status ${response.status}` };
}

function mapStripeError(status: number, error: StripeErrorBody): ProviderRequestError {
  const message = error.message;
  if (error.type === "idempotency_error") {
    return new ProviderRequestError(409, message || "Stripe idempotency key was reused with different parameters");
  }

  if (status === 401 || status === 403) {
    return new ProviderRequestError(status, message || "Stripe API key is invalid");
  }

  if (status === 400 || status === 404) {
    return new ProviderRequestError(400, message);
  }

  if (status === 429) {
    return new ProviderRequestError(429, message || "Stripe rate limit exceeded");
  }

  return new ProviderRequestError(502, message, status);
}

export const triggers: readonly (IntegrationDefinition | PollDefinition)[] = [stripeEvent];
