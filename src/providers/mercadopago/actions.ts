import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "mercadopago";

interface MercadoPagoActionSource {
  name: MercadoPagoActionName;
  operationType: ActionDefinition["operationType"];
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

/**
 * Decimal money as Mercado Pago expects it: a string with exactly two fraction digits.
 * Integer centavos, the Stripe habit, are rejected before any request.
 */
const decimalAmount = s.stringPattern("^\\d+\\.\\d{2}$", {
  description: "Amount in major units with exactly two decimals, for example 1250.50. Never centavos.",
});

const currency = s.stringEnum(
  ["ARS", "BRL", "MXN", "CLP", "COP", "PEN", "UYU", "BOB", "PYG", "USD", "CRC", "DOP", "HNL", "NIO", "GTQ", "VES"],
  { description: "ISO currency code. Mexico accounts use MXN." },
);

const metadata = s.record(s.union([s.string(), s.number(), s.boolean()]), {
  description: "Caller metadata. Mercado Pago stores it and returns it unchanged.",
});

const paging = s.object(
  {
    total: s.integer({ description: "Total matches for this search." }),
    limit: s.integer({ description: "Page size." }),
    offset: s.integer({ description: "Offset of this page." }),
  },
  { description: "Offset pagination. Mercado Pago does not use Stripe cursors." },
);

const pageInput = {
  limit: s.integer({ minimum: 1, maximum: 50, description: "Page size, from 1 to 50." }),
  offset: s.integer({ minimum: 0, description: "Number of matches to skip." }),
};

const identification = s.object(
  {
    type: s.stringEnum(["RFC", "CURP"], { description: "Mexico identification type." }),
    number: s.string({ description: "Identification number, digits and letters only, no punctuation." }),
  },
  { description: "Payer identification. Mexico uses RFC or CURP." },
);

const phone = s.object(
  {
    area_code: s.string({ description: "Phone area code." }),
    number: s.string({ description: "Phone number without the area code." }),
  },
  { description: "A phone number split the way Mercado Pago stores it." },
);

const address = s.object(
  {
    zip_code: s.string({ description: "Postal code." }),
    street_name: s.string({ description: "Street name." }),
    street_number: s.string({ description: "Street number." }),
    city: s.string({ description: "City." }),
    state: s.string({ description: "State." }),
    country: s.string({ description: "Country." }),
  },
  { description: "A customer address." },
);

const customerFields = {
  email: s.email("Customer email. Unique per Mercado Pago account."),
  first_name: s.string({ description: "Customer given name." }),
  last_name: s.string({ description: "Customer family name." }),
  phone,
  identification,
  address,
  description: s.string({ description: "Internal description of the customer." }),
  metadata,
};

const rawObject = s.looseObject({}, { description: "The Mercado Pago object, kept so unlisted fields stay available." });

const paymentStatus = s.stringEnum(
  ["pending", "approved", "authorized", "in_process", "in_mediation", "rejected", "cancelled", "refunded", "charged_back"],
  { description: "Payment status. pending is not paid. OXXO and SPEI stay pending until the payer finishes." },
);

const normalizedPayment = s.object(
  {
    id: s.string({ description: "Payment id." }),
    status: paymentStatus,
    statusDetail: s.nullable(s.string({ description: "Finer status, such as accredited or pending_waiting_payment." })),
    pending: s.boolean({ description: "True when the payer still has to act or Mercado Pago has not accredited the money." }),
    paid: s.boolean({ description: "True only when status is approved." }),
    paymentMethodId: s.nullable(s.string({ description: "Method id, such as visa, oxxo, or clabe." })),
    paymentTypeId: s.nullable(s.string({ description: "Method family, such as credit_card, ticket, or bank_transfer." })),
    transactionAmount: s.nullable(s.string({ description: "Original amount as a two-decimal string." })),
    amountRefunded: s.nullable(s.string({ description: "Amount already refunded, as a two-decimal string." })),
    currency: s.nullable(s.string({ description: "Currency code." })),
    description: s.nullable(s.string({ description: "Payment description." })),
    externalReference: s.nullable(s.string({ description: "Caller reference stored on the payment." })),
    dateCreated: s.nullable(s.string({ description: "Creation time." })),
    dateApproved: s.nullable(s.string({ description: "Approval time. Empty while pending." })),
    moneyReleaseDate: s.nullable(s.string({ description: "When the money becomes available." })),
    payerEmail: s.nullable(s.string({ description: "Payer email, when Mercado Pago returned one." })),
    ticketUrl: s.nullable(s.string({ description: "OXXO or SPEI instruction URL. Empty for card payments." })),
    raw: rawObject,
  },
  {
    required: ["id", "status", "pending", "paid", "raw"],
    description: "A payment normalized for chat. pending is never treated as paid.",
  },
);

const merchantOrderStatus = s.stringEnum(["opened", "closed", "expired"], {
  description: "Merchant order status. opened with a remaining amount is the open-invoice equivalent.",
});

const normalizedOrder = s.object(
  {
    id: s.string({ description: "Merchant order id." }),
    status: merchantOrderStatus,
    open: s.boolean({ description: "True when the order is opened and still has an amount due." }),
    externalReference: s.nullable(s.string({ description: "Caller reference." })),
    preferenceId: s.nullable(s.string({ description: "Checkout Pro preference that created this order." })),
    totalAmount: s.string({ description: "Order total as a two-decimal string." }),
    paidAmount: s.string({ description: "Amount already paid as a two-decimal string." }),
    amountDue: s.string({ description: "Remaining amount as a two-decimal string. Chat converts this to centavos." }),
    currency: s.string({ description: "Currency. Mexico orders are MXN." }),
    payerEmail: s.nullable(s.string({ description: "Payer email when present on the order." })),
    dateCreated: s.nullable(s.string({ description: "Creation time." })),
    raw: rawObject,
  },
  {
    required: ["id", "status", "open", "totalAmount", "paidAmount", "amountDue", "currency", "raw"],
    description: "A Checkout Pro merchant order, the closest Mercado Pago object to an invoice.",
  },
);

const subscriptionInvoiceStatus = s.stringEnum(["scheduled", "processed", "recycling", "cancelled"], {
  description: "Subscription bill status. scheduled and recycling are open. processed is paid only after the linked payment is approved.",
});

const normalizedSubscriptionInvoice = s.object(
  {
    id: s.string({ description: "Authorized payment id." }),
    preapprovalId: s.nullable(s.string({ description: "Subscription id this bill belongs to." })),
    status: subscriptionInvoiceStatus,
    open: s.boolean({ description: "True when the bill is still collectible." }),
    paid: s.boolean({ description: "True only when the linked payment is approved." }),
    transactionAmount: s.nullable(s.string({ description: "Bill amount as a two-decimal string." })),
    currency: s.nullable(s.string({ description: "Currency code." })),
    paymentId: s.nullable(s.string({ description: "Linked payment id, when Mercado Pago has created one." })),
    paymentStatus: s.nullable(s.string({ description: "Status of the linked payment. Fetched when a payment id is present." })),
    dateCreated: s.nullable(s.string({ description: "Creation time." })),
    raw: rawObject,
  },
  {
    required: ["id", "status", "open", "paid", "raw"],
    description: "A subscription bill. processed is not paid until the linked payment is approved.",
  },
);

const autoRecurring = s.object(
  {
    frequency: s.integer({ minimum: 1, description: "How many frequency units between charges. 1 with months is monthly." }),
    frequency_type: s.stringEnum(["days", "months"], { description: "Unit of the billing interval." }),
    transaction_amount: decimalAmount,
    currency_id: currency,
    repetitions: s.integer({ minimum: 1, description: "How many times to charge. Omit for an open-ended plan." }),
    free_trial: s.object(
      {
        frequency: s.integer({ minimum: 1, description: "Trial length." }),
        frequency_type: s.stringEnum(["days", "months"], { description: "Trial unit." }),
      },
      { required: ["frequency", "frequency_type"], description: "Optional free trial before the first charge." },
    ),
  },
  {
    required: ["frequency", "frequency_type", "transaction_amount", "currency_id"],
    description: "Recurring terms. This is the Mercado Pago stand-in for a Stripe price.",
  },
);

const actions: MercadoPagoActionSource[] = [
  action(
    "identify_account",
    "read",
    "Identify the Mercado Pago account for the current access token. Mexico connections must be site MLM.",
    input("No input is required to identify the account.", {}),
    output("The connected Mercado Pago account.", {
      accountId: s.string({ description: "Mercado Pago user id." }),
      email: s.nullable(s.string({ description: "Account email." })),
      nickname: s.nullable(s.string({ description: "Account nickname." })),
      siteId: s.string({ description: "Site id. MLM is Mexico." }),
      country: s.string({ description: "Country implied by the site. MX for MLM." }),
    }),
  ),
  action(
    "get_balance",
    "read",
    "Read available, unavailable, and total account money. Uses the live balance when Mercado Pago still serves it, otherwise the latest releases report. A report balance is not live.",
    input("No input is required to read the balance.", {}),
    output("Account money.", {
      available: s.nullable(s.string({ description: "Available amount as a two-decimal string. Null when only a report task exists." })),
      unavailable: s.nullable(s.string({ description: "Unavailable amount as a two-decimal string." })),
      total: s.nullable(s.string({ description: "Total amount as a two-decimal string." })),
      currency: s.nullable(s.string({ description: "Currency code." })),
      source: s.stringEnum(["live", "report"], { description: "live is the account balance. report is the latest releases report." }),
      asOf: s.nullable(s.string({ description: "When this figure was produced. Empty for a live read." })),
    }),
  ),
  action(
    "list_balance_transactions",
    "read",
    "List settlement-report rows for a date range. This is a generated report, not a live ledger. A report that is still processing returns a task id and no rows.",
    input(
      "Input for listing settlement rows.",
      {
        beginDate: s.date("Range start, inclusive, as YYYY-MM-DD."),
        endDate: s.date("Range end, inclusive, as YYYY-MM-DD."),
      },
      ["beginDate", "endDate"],
    ),
    output("Settlement rows, or a task that is not ready.", {
      ready: s.boolean({ description: "Whether the report file was available." }),
      taskId: s.nullable(s.string({ description: "Report task id when the file is not ready yet." })),
      transactions: s.array(
        s.object(
          {
            date: s.nullable(s.string({ description: "Settlement or transaction date." })),
            type: s.nullable(s.string({ description: "Row type, such as SETTLEMENT or REFUND." })),
            gross: s.nullable(s.string({ description: "Gross amount as a two-decimal string." })),
            fee: s.nullable(s.string({ description: "Fee amount as a two-decimal string." })),
            net: s.nullable(s.string({ description: "Net amount as a two-decimal string." })),
            currency: s.nullable(s.string({ description: "Currency code." })),
            sourceId: s.nullable(s.string({ description: "Source payment or operation id." })),
          },
          { description: "One settlement-report row." },
        ),
        { description: "Rows from the report. Empty when the report is not ready." },
      ),
    }),
  ),
  action(
    "create_releases_report",
    "write",
    "Ask Mercado Pago to generate a releases report for a date range. Creating the report does not move money. The file is fetched later with get_report_task.",
    input(
      "Input for creating a releases report.",
      {
        beginDate: s.date("Range start, inclusive."),
        endDate: s.date("Range end, inclusive."),
      },
      ["beginDate", "endDate"],
    ),
    output("The created report task.", {
      taskId: s.string({ description: "Report task id." }),
      status: s.nullable(s.string({ description: "Task status, when Mercado Pago returned one." })),
    }),
  ),
  action(
    "get_report_task",
    "read",
    "Read a releases or settlement report task. Poll until ready is true, then download with list_balance_transactions or the file name.",
    input(
      "Input for reading a report task.",
      {
        taskId: s.string({ minLength: 1, description: "Report task id." }),
        kind: s.stringEnum(["release", "settlement"], { description: "Which report family the task belongs to." }),
      },
      ["taskId", "kind"],
    ),
    output("Report task status.", {
      taskId: s.string({ description: "Report task id." }),
      status: s.nullable(s.string({ description: "Task status." })),
      ready: s.boolean({ description: "Whether the file can be downloaded." }),
      fileName: s.nullable(s.string({ description: "File name once the report is ready." })),
    }),
  ),
  action(
    "create_customer",
    "write",
    "Create a Mercado Pago customer. Email is unique per account. This does not charge the customer.",
    input("Input for creating a customer.", customerFields, ["email"]),
    output("The created customer.", { customer: rawObject }),
  ),
  action(
    "update_customer",
    "write",
    "Update a Mercado Pago customer. Only the fields you send are changed.",
    input("Input for updating a customer.", { customerId: s.string({ minLength: 1, description: "Customer id." }), ...customerFields }, ["customerId"]),
    output("The updated customer.", { customer: rawObject }),
  ),
  action(
    "get_customer",
    "read",
    "Retrieve a Mercado Pago customer by id.",
    input("Input for retrieving a customer.", { customerId: s.string({ minLength: 1, description: "Customer id." }) }, ["customerId"]),
    output("The customer.", { customer: rawObject }),
  ),
  action(
    "search_customers",
    "read",
    "Search customers by exact email. Mercado Pago has no free-text customer query.",
    input("Input for searching customers.", { email: s.email("Exact customer email."), ...pageInput }, ["email"]),
    output("Customer search page.", { customers: s.array(rawObject, { description: "Matching customers." }), paging }),
  ),
  action(
    "list_customers",
    "read",
    "List customers with offset pagination. Email is the supported filter; a list without email is best-effort and may be empty.",
    input("Input for listing customers.", { email: s.email("Optional exact email filter."), ...pageInput }),
    output("Customer page.", { customers: s.array(rawObject, { description: "Customers on this page." }), paging }),
  ),
  action(
    "delete_customer",
    "destructive",
    "Delete a Mercado Pago customer by id.",
    input("Input for deleting a customer.", { customerId: s.string({ minLength: 1, description: "Customer id." }) }, ["customerId"]),
    output("Delete result.", {
      deleted: s.boolean({ description: "Whether Mercado Pago accepted the delete." }),
      id: s.string({ description: "Deleted customer id." }),
    }),
  ),
  action(
    "create_plan",
    "write",
    "Create a subscription plan. Mercado Pago has no product or price objects; the plan reason is the name and auto_recurring is the price.",
    input(
      "Input for creating a plan.",
      {
        reason: s.string({ minLength: 1, description: "Plan name shown to the payer." }),
        autoRecurring,
        backUrl: s.url("URL Mercado Pago sends the payer to after they subscribe."),
      },
      ["reason", "autoRecurring"],
    ),
    output("The created plan.", {
      planId: s.string({ description: "Plan id." }),
      status: s.nullable(s.string({ description: "Plan status." })),
      initPoint: s.nullable(s.url("URL a payer opens to subscribe. This is not a one-time payment link.")),
      raw: rawObject,
    }),
  ),
  action(
    "update_plan",
    "write",
    "Update mutable fields on a subscription plan.",
    input(
      "Input for updating a plan.",
      {
        planId: s.string({ minLength: 1, description: "Plan id." }),
        reason: s.string({ description: "Replacement plan name." }),
        autoRecurring,
      },
      ["planId"],
    ),
    output("The updated plan.", { plan: rawObject }),
  ),
  action(
    "get_plan",
    "read",
    "Retrieve a subscription plan by id.",
    input("Input for retrieving a plan.", { planId: s.string({ minLength: 1, description: "Plan id." }) }, ["planId"]),
    output("The plan.", { plan: rawObject }),
  ),
  action(
    "search_plans",
    "read",
    "Search subscription plans. This is the catalog list: Mercado Pago does not store one-time products.",
    input(
      "Input for searching plans.",
      {
        status: s.stringEnum(["active", "inactive"], { description: "Filter by plan status." }),
        q: s.string({ description: "Free-text query Mercado Pago applies to plan search." }),
        ...pageInput,
      },
    ),
    output("Plan search page.", { plans: s.array(rawObject, { description: "Matching plans." }), paging }),
  ),
  action(
    "get_payment",
    "read",
    "Retrieve one payment. pending, including OXXO and SPEI, is not paid.",
    input("Input for retrieving a payment.", { paymentId: s.string({ minLength: 1, description: "Payment id." }) }, ["paymentId"]),
    output("The payment.", { payment: normalizedPayment }),
  ),
  action(
    "search_payments",
    "read",
    "Search payments. Results cover about the last 90 days. A missing result is not proof the payment does not exist when you have its id. sort and criteria default to date_created desc.",
    input("Input for searching payments.", {
      status: paymentStatus,
      externalReference: s.string({ description: "Caller reference stored on the payment." }),
      beginDate: s.string({ description: "Range start. ISO 8601, or a relative value such as NOW-7DAYS." }),
      endDate: s.string({ description: "Range end. ISO 8601, or NOW." }),
      range: s.stringEnum(["date_created", "date_last_updated", "money_release_date", "date_approved"], {
        description: "Which date the range filters.",
      }),
      payerId: s.string({ description: "Payer id." }),
      sort: s.string({ description: "Sort field. Defaults to date_created." }),
      criteria: s.stringEnum(["asc", "desc"], { description: "Sort direction. Defaults to desc." }),
      ...pageInput,
    }),
    output("Payment search page.", {
      payments: s.array(normalizedPayment, { description: "Matching payments." }),
      paging,
    }),
  ),
  action(
    "get_merchant_order",
    "read",
    "Retrieve a Checkout Pro merchant order by id. This is the invoice substitute for a payment link.",
    input("Input for retrieving a merchant order.", { orderId: s.string({ minLength: 1, description: "Merchant order id." }) }, ["orderId"]),
    output("The merchant order.", { order: normalizedOrder }),
  ),
  action(
    "search_merchant_orders",
    "read",
    "Search merchant orders. Search covers about the last 90 days. Older orders are fetched by id.",
    input("Input for searching merchant orders.", {
      status: merchantOrderStatus,
      externalReference: s.string({ description: "Caller reference." }),
      preferenceId: s.string({ description: "Preference id that created the order." }),
      ...pageInput,
    }),
    output("Merchant order page.", { orders: s.array(normalizedOrder, { description: "Matching orders." }), paging }),
  ),
  action(
    "list_open_merchant_orders",
    "read",
    "List Checkout Pro orders that are still opened and have an amount due. This is the open-invoice list.",
    input("Input for listing open merchant orders.", pageInput),
    output("Open merchant orders.", { orders: s.array(normalizedOrder, { description: "Opened orders with an amount due." }), paging }),
  ),
  action(
    "get_subscription_invoice",
    "read",
    "Retrieve a subscription bill. A processed bill is paid only when its linked payment is approved.",
    input(
      "Input for retrieving a subscription bill.",
      { invoiceId: s.string({ minLength: 1, description: "Authorized payment id." }) },
      ["invoiceId"],
    ),
    output("The subscription bill.", { invoice: normalizedSubscriptionInvoice }),
  ),
  action(
    "search_subscription_invoices",
    "read",
    "Search subscription bills. scheduled and recycling are open. processed is checked against the linked payment before it counts as paid.",
    input("Input for searching subscription bills.", {
      preapprovalId: s.string({ description: "Subscription id." }),
      paymentId: s.string({ description: "Linked payment id." }),
      payerId: s.string({ description: "Payer id." }),
      status: subscriptionInvoiceStatus,
      ...pageInput,
    }),
    output("Subscription bill page.", {
      invoices: s.array(normalizedSubscriptionInvoice, { description: "Matching bills." }),
      paging,
    }),
  ),
  action(
    "create_payment_link",
    "write",
    "Create a Checkout Pro payment link for one exact amount. Creating the link charges nobody. The payer chooses card, OXXO, SPEI, or account money. Repeating the same idempotency key returns the same link.",
    input(
      "Input for creating a payment link.",
      {
        amount: decimalAmount,
        currency,
        description: s.string({ minLength: 1, description: "What the payer is paying for, shown at checkout." }),
        idempotencyKey: s.string({ minLength: 1, maxLength: 64, description: "Stable key for this charge. A repeat returns the same link." }),
        payerEmail: s.email("Payer email to prefill at checkout."),
        externalReference: s.string({ maxLength: 64, description: "Caller reference. Defaults to the idempotency key." }),
        expiresAt: s.dateTime("When the link stops accepting payment."),
        metadata,
      },
      ["amount", "currency", "description", "idempotencyKey"],
    ),
    output("The payment link. Send url to the payer in a separate approved step.", {
      paymentLinkId: s.string({ description: "Preference id." }),
      url: s.url("Hosted checkout URL. Creating it charges nobody."),
      sandboxUrl: s.nullable(s.url("Sandbox checkout URL, when Mercado Pago returned one.")),
      externalReference: s.string({ description: "Reference stored on the preference." }),
      amount: decimalAmount,
      currency,
    }),
  ),
  action(
    "get_payment_link",
    "read",
    "Retrieve a Checkout Pro payment link by preference id.",
    input("Input for retrieving a payment link.", { paymentLinkId: s.string({ minLength: 1, description: "Preference id." }) }, ["paymentLinkId"]),
    output("The payment link.", {
      paymentLinkId: s.string({ description: "Preference id." }),
      url: s.nullable(s.url("Hosted checkout URL.")),
      externalReference: s.nullable(s.string({ description: "Stored reference." })),
      raw: rawObject,
    }),
  ),
  action(
    "search_payment_links",
    "read",
    "Search Checkout Pro payment links by external reference. Search covers about the last 90 days.",
    input("Input for searching payment links.", {
      externalReference: s.string({ description: "Reference stored on the preference." }),
      ...pageInput,
    }),
    output("Payment link page.", { paymentLinks: s.array(rawObject, { description: "Matching preferences." }), paging }),
  ),
  action(
    "update_payment_link",
    "write",
    "Update a Checkout Pro payment link that has not been paid. This can change the amount of a link already sent.",
    input(
      "Input for updating a payment link.",
      {
        paymentLinkId: s.string({ minLength: 1, description: "Preference id." }),
        amount: decimalAmount,
        currency,
        description: s.string({ description: "Replacement description." }),
        expiresAt: s.dateTime("Replacement expiration."),
      },
      ["paymentLinkId"],
    ),
    output("The updated payment link.", {
      paymentLinkId: s.string({ description: "Preference id." }),
      url: s.nullable(s.url("Hosted checkout URL.")),
      raw: rawObject,
    }),
  ),
  action(
    "create_subscription",
    "write",
    "Create a subscription and return an authorization URL. The payer must open that URL before any charge. This is not a one-time payment link.",
    input(
      "Input for creating a subscription.",
      {
        reason: s.string({ minLength: 1, description: "Description shown to the payer." }),
        payerEmail: s.email("Payer email."),
        autoRecurring,
        planId: s.string({ description: "Existing plan id. When set, autoRecurring can be omitted." }),
        externalReference: s.string({ description: "Caller reference." }),
        backUrl: s.url("URL Mercado Pago sends the payer to after authorization."),
      },
      ["reason", "payerEmail"],
    ),
    output("The subscription and its authorization URL.", {
      subscriptionId: s.string({ description: "Subscription id." }),
      status: s.nullable(s.string({ description: "Subscription status. pending until the payer authorizes." })),
      authorizationUrl: s.nullable(s.url("URL the payer opens to authorize. Not a one-time payment link.")),
      raw: rawObject,
    }),
  ),
  action(
    "get_subscription",
    "read",
    "Retrieve a subscription by id.",
    input("Input for retrieving a subscription.", { subscriptionId: s.string({ minLength: 1, description: "Subscription id." }) }, ["subscriptionId"]),
    output("The subscription.", { subscription: rawObject }),
  ),
  action(
    "update_subscription",
    "write",
    "Update mutable subscription fields other than pause and cancel. Use pause_subscription or cancel_subscription for status.",
    input(
      "Input for updating a subscription.",
      {
        subscriptionId: s.string({ minLength: 1, description: "Subscription id." }),
        reason: s.string({ description: "Replacement description." }),
        externalReference: s.string({ description: "Replacement caller reference." }),
        autoRecurring,
      },
      ["subscriptionId"],
    ),
    output("The updated subscription.", { subscription: rawObject }),
  ),
  action(
    "search_subscriptions",
    "read",
    "Search subscriptions by status, payer email, plan, or a free-text query.",
    input("Input for searching subscriptions.", {
      status: s.stringEnum(["pending", "authorized", "paused", "cancelled"], { description: "Subscription status." }),
      payerEmail: s.email("Payer email."),
      planId: s.string({ description: "Plan id." }),
      q: s.string({ description: "Free-text query." }),
      ...pageInput,
    }),
    output("Subscription page.", { subscriptions: s.array(rawObject, { description: "Matching subscriptions." }), paging }),
  ),
  action(
    "pause_subscription",
    "write",
    "Pause a subscription. No further charges are created until it is authorized again.",
    input("Input for pausing a subscription.", { subscriptionId: s.string({ minLength: 1, description: "Subscription id." }) }, ["subscriptionId"]),
    output("The paused subscription.", { subscriptionId: s.string({ description: "Subscription id." }), status: s.string({ description: "Status after the update." }) }),
  ),
  action(
    "cancel_subscription",
    "destructive",
    "Cancel a subscription. Mercado Pago stops billing it.",
    input("Input for cancelling a subscription.", { subscriptionId: s.string({ minLength: 1, description: "Subscription id." }) }, ["subscriptionId"]),
    output("The cancelled subscription.", { subscriptionId: s.string({ description: "Subscription id." }), status: s.string({ description: "Status after the update." }) }),
  ),
  action(
    "list_refunds",
    "read",
    "List refunds already recorded for a payment. This does not move money.",
    input("Input for listing refunds.", { paymentId: s.string({ minLength: 1, description: "Payment id." }) }, ["paymentId"]),
    output("Refunds for the payment.", { refunds: s.array(rawObject, { description: "Refund records." }) }),
  ),
  action(
    "get_refund",
    "read",
    "Retrieve one refund. in_process is not approved.",
    input(
      "Input for retrieving a refund.",
      {
        paymentId: s.string({ minLength: 1, description: "Payment id." }),
        refundId: s.string({ minLength: 1, description: "Refund id." }),
      },
      ["paymentId", "refundId"],
    ),
    output("The refund.", {
      refundId: s.string({ description: "Refund id." }),
      paymentId: s.string({ description: "Payment id." }),
      amount: s.nullable(s.string({ description: "Refunded amount as a two-decimal string." })),
      status: s.nullable(s.string({ description: "approved, in_process, or rejected. in_process is not done." })),
      approved: s.boolean({ description: "True only when status is approved." }),
      raw: rawObject,
    }),
  ),
  action(
    "create_refund",
    "destructive",
    "Refund an approved payment. Omit amount for a full refund. This returns money to the payer. A repeated idempotency key does not create a second refund.",
    input(
      "Input for creating a refund.",
      {
        paymentId: s.string({ minLength: 1, description: "Payment id to refund." }),
        idempotencyKey: s.string({ minLength: 1, description: "Stable key for this refund." }),
        amount: decimalAmount,
      },
      ["paymentId", "idempotencyKey"],
    ),
    output("The refund Mercado Pago recorded.", {
      refundId: s.string({ description: "Refund id." }),
      paymentId: s.string({ description: "Payment id." }),
      amount: s.nullable(s.string({ description: "Refunded amount as a two-decimal string." })),
      status: s.nullable(s.string({ description: "approved, in_process, or rejected." })),
      approved: s.boolean({ description: "True only when status is approved." }),
    }),
  ),
];

export type MercadoPagoActionName =
  | "identify_account"
  | "get_balance"
  | "list_balance_transactions"
  | "create_releases_report"
  | "get_report_task"
  | "create_customer"
  | "update_customer"
  | "get_customer"
  | "search_customers"
  | "list_customers"
  | "delete_customer"
  | "create_plan"
  | "update_plan"
  | "get_plan"
  | "search_plans"
  | "get_payment"
  | "search_payments"
  | "get_merchant_order"
  | "search_merchant_orders"
  | "list_open_merchant_orders"
  | "get_subscription_invoice"
  | "search_subscription_invoices"
  | "create_payment_link"
  | "get_payment_link"
  | "search_payment_links"
  | "update_payment_link"
  | "create_subscription"
  | "get_subscription"
  | "update_subscription"
  | "search_subscriptions"
  | "pause_subscription"
  | "cancel_subscription"
  | "list_refunds"
  | "get_refund"
  | "create_refund";

export const mercadoPagoActions: ActionDefinition[] = actions.map((source) =>
  defineProviderAction(service, {
    name: source.name,
    operationType: source.operationType,
    description: source.description,
    requiredScopes: [],
    providerPermissions: [],
    inputSchema: source.inputSchema,
    outputSchema: source.outputSchema,
  }),
);

function action(
  name: MercadoPagoActionName,
  operationType: ActionDefinition["operationType"],
  description: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): MercadoPagoActionSource {
  return { name, operationType, description, inputSchema, outputSchema };
}

function input(description: string, properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, description);
}

function output(description: string, properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
  return s.actionOutput(properties, description, required);
}
