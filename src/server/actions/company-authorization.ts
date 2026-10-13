import type { ProviderHttpDispatchOptions } from "../../core/provider-http-dispatch.ts";
import type { MiddlewareHandler } from "hono";

import { AsyncLocalStorage } from "node:async_hooks";

interface CompanyRequest {
  grant: string;
  operationId: string;
}
const requests = new AsyncLocalStorage<CompanyRequest>();

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

/** Every provider hop rechecks current company membership and connection permissions. */
export function companyDispatchOptions(
  existing?: ProviderHttpDispatchOptions,
): ProviderHttpDispatchOptions | undefined {
  if (process.env.COMPANY_ONBOARDING_ENABLED !== "true") return existing;
  const endpoint = process.env.COMPANY_AUTHORIZATION_URL || "";
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(endpoint))
    throw new Error("COMPANY_AUTHORIZATION_URL must name the trusted backend authorization endpoint");
  return {
    ...existing,
    async beforeAttempt(attempt, signal) {
      // Credential verification and OAuth exchange do not read customer work data.
      if (["action", "proxy", "trigger"].includes(attempt.context.operation)) {
        const request = requests.getStore();
        if (!request?.grant || !request.operationId || !attempt.context.actionId || !attempt.context.connectionId)
          return { allow: false };
        try {
          const response = await fetch(endpoint, {
            method: "POST",
            redirect: "error",
            headers: { Authorization: `Bearer ${request.grant}`, "Content-Type": "application/json" },
            body: JSON.stringify({ actionId: attempt.context.actionId, operationId: request.operationId }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
          });
          if (!response.ok) return { allow: false };
          const identity = (await response.json()) as { connection_id?: string; service?: string };
          if (identity.connection_id !== attempt.context.connectionId || identity.service !== attempt.context.service)
            return { allow: false };
        } catch {
          return { allow: false, retryAfterSeconds: 2 };
        }
      }
      return existing ? existing.beforeAttempt(attempt, signal) : { allow: true };
    },
  };
}

/** Replayed results and prepared approvals need current authority even without a provider call. */
export async function authorizeCompanyAction(
  actionId: string,
  connectionId: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (process.env.COMPANY_ONBOARDING_ENABLED !== "true") return true;
  const request = requests.getStore();
  const endpoint = process.env.COMPANY_AUTHORIZATION_URL || "";
  if (!request?.grant || !request.operationId || !connectionId || !/^https:\/\//.test(endpoint)) return false;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${request.grant}`, "Content-Type": "application/json" },
      body: JSON.stringify({ actionId, operationId: request.operationId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const identity = (await response.json()) as { connection_id?: string };
    return identity.connection_id === connectionId;
  } catch {
    return false;
  }
}
