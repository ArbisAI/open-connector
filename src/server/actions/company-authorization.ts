import type { ProviderHttpDispatchOptions } from "../../core/provider-http-dispatch.ts";
import type { MiddlewareHandler } from "hono";

import { AsyncLocalStorage } from "node:async_hooks";

interface CompanyRequest {
  grant: string;
  operationId: string;
}

export interface CompanyExecutionTarget {
  operation: "action" | "proxy" | "trigger";
  service: string;
  connectionId?: string;
  actionId?: string;
  signal?: AbortSignal;
}

export type CompanyAuthorizationDecision =
  | { ok: true }
  | { ok: false; reason: "denied" }
  | { ok: false; reason: "unavailable"; retryAfterSeconds: number };

const requests = new AsyncLocalStorage<CompanyRequest>();
const authorityTimeoutMs = 2000;
const authorityRetryAfterSeconds = 2;

/** Personal execution authority is separate from the connector service bearer. */
export function companyAuthorizationMiddleware(): MiddlewareHandler {
  return async (context, next) =>
    requests.run(
      {
        grant: context.req.header("X-Nexo-Authorization") || "",
        operationId: context.req.header("X-Nexo-Operation") || "",
      },
      next,
    );
}

/**
 * HTTPS, or loopback HTTP for a local authority. One allowlist for startup and every check.
 * `http://localhost` without a port or path is accepted; the previous pattern required `:` or `/`.
 */
export function companyAuthorizationEndpoint(value = process.env.COMPANY_AUTHORIZATION_URL || ""): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hash) return undefined;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url;
  return undefined;
}

export function companyAuthorizationEnabled(): boolean {
  return process.env.COMPANY_ONBOARDING_ENABLED === "true";
}

/** Fail at startup when the flag is on and the endpoint is not one both checks will accept. */
export function assertCompanyAuthorizationConfigured(): void {
  if (!companyAuthorizationEnabled()) return;
  if (!companyAuthorizationEndpoint()) {
    throw new Error("COMPANY_AUTHORIZATION_URL must name the trusted backend authorization endpoint");
  }
}

/** Every provider hop rechecks current company membership and connection permissions. */
export function companyDispatchOptions(
  existing?: ProviderHttpDispatchOptions,
): ProviderHttpDispatchOptions | undefined {
  if (!companyAuthorizationEnabled()) return existing;
  assertCompanyAuthorizationConfigured();
  return {
    ...existing,
    async beforeAttempt(attempt, signal) {
      // Credential verification and OAuth exchange do not read customer work data.
      if (
        attempt.context.operation === "action" ||
        attempt.context.operation === "proxy" ||
        attempt.context.operation === "trigger"
      ) {
        const decision = await authorizeCompanyExecution({
          operation: attempt.context.operation,
          service: attempt.context.service ?? "",
          connectionId: attempt.context.connectionId,
          actionId: attempt.context.actionId,
          signal,
        });
        if (!decision.ok) {
          return decision.reason === "unavailable"
            ? { allow: false, retryAfterSeconds: decision.retryAfterSeconds }
            : { allow: false };
        }
      }
      return existing ? existing.beforeAttempt(attempt, signal) : { allow: true };
    },
  };
}

/**
 * Recheck the current grant before any customer provider work, including SaaS, Marketplace,
 * and replayed approvals that never make a local provider HTTP call.
 * Proxy and trigger have no action id; the authority identifies the connection by grant.
 */
export async function authorizeCompanyExecution(target: CompanyExecutionTarget): Promise<CompanyAuthorizationDecision> {
  if (!companyAuthorizationEnabled()) return { ok: true };
  const request = requests.getStore();
  const endpoint = companyAuthorizationEndpoint();
  if (!request?.grant || !request.operationId || !target.connectionId || !target.service || !endpoint) {
    return { ok: false, reason: "denied" };
  }
  try {
    const response = await postCompanyAuthorization(endpoint, request, target);
    if (response.status >= 300 && response.status < 400) return { ok: false, reason: "denied" };
    if (!response.ok) return { ok: false, reason: "denied" };
    if (response.url && !sameAuthorityOrigin(response.url, endpoint)) return { ok: false, reason: "denied" };
    const identity = (await response.json()) as { connection_id?: string; service?: string };
    if (identity.connection_id !== target.connectionId || identity.service !== target.service) {
      return { ok: false, reason: "denied" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable", retryAfterSeconds: authorityRetryAfterSeconds };
  }
}

/**
 * Manual redirect so Workers do not reject `redirect: "error"` before the request is sent.
 * The endpoint was already restricted to HTTPS or the configured loopback host, so this
 * request does not go through the public-egress guard, which rejects loopback.
 */
async function postCompanyAuthorization(
  endpoint: URL,
  request: CompanyRequest,
  target: CompanyExecutionTarget,
): Promise<Response> {
  const signal = target.signal
    ? AbortSignal.any([target.signal, AbortSignal.timeout(authorityTimeoutMs)])
    : AbortSignal.timeout(authorityTimeoutMs);
  return fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { Authorization: `Bearer ${request.grant}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      actionId: target.actionId,
      operationId: request.operationId,
      connectionId: target.connectionId,
      service: target.service,
    }),
    signal,
  });
}

function sameAuthorityOrigin(responseUrl: string, endpoint: URL): boolean {
  try {
    return new URL(responseUrl).origin === endpoint.origin;
  } catch {
    return false;
  }
}
