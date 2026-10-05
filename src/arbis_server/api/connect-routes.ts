import type { UpstreamFetch } from "../arbis-app.ts";
import type { PostAuthorizationInput } from "./post-authorization.ts";

import { Hono } from "hono";
import { optionalString } from "../../core/cast.ts";
import { jsonError, readJsonBody } from "../../server/api/http-utils.ts";
import { callPostAuthorizationApi } from "./post-authorization.ts";

export interface ArbisConnectRoutesOptions {
  /** Defaults to the placeholder in `post-authorization.ts`. */
  afterAuthorize?: (input: PostAuthorizationInput) => Promise<Record<string, unknown>>;
}

const AUTHORIZATIONS_PATH = "/api/oauth/authorizations";

/**
 * `POST /api/connect`  (registered in `arbis-app.ts`)
 *
 * Body is the `/api/oauth/authorizations` body (`service`, optional `connectionName`,
 * `authorizationOptionIds`, `clientId`, `clientSecret`, ...) plus optional `userId` / `companyId`.
 * It calls `/api/oauth/authorizations`, and only when that succeeds calls the follow-up API.
 */
export function createArbisConnectRoutes(
  upstream: UpstreamFetch,
  options: ArbisConnectRoutesOptions = {},
): Hono {
  const routes = new Hono();
  const afterAuthorize = options.afterAuthorize ?? callPostAuthorizationApi;

  routes.post("/api/connect", async (context) => {
    const body = await readJsonBody(context);

    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["authorization", "x-oo-connector-alias"]) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }

    const response = await upstream(
      new Request(new URL(AUTHORIZATIONS_PATH, context.req.url), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      // Surface the authorization failure unchanged; the follow-up call is skipped.
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      });
    }

    const authorization = (await response.json()) as { authorizationUrl: string; state: string };
    const service = optionalString(body.service) ?? "";
    try {
      const next = await afterAuthorize({
        service,
        connectionName: optionalString(body.connectionName) ?? optionalString(body.alias),
        userId: optionalString(body.userId),
        companyId: optionalString(body.companyId),
        authorization,
      });
      return context.json({ ...authorization, next });
    } catch (error) {
      return jsonError(
        context,
        502,
        "post_authorization_failed",
        error instanceof Error ? error.message : "Post-authorization call failed.",
      );
    }
  });

  return routes;
}
