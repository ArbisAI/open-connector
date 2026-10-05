import type { Hono } from "hono";

import { Hono as HonoApp } from "hono";
import { createArbisConnectRoutes } from "./api/connect-routes.ts";

/** The existing server's request handler (for example `runtime.fetch`). */
export type UpstreamFetch = (request: Request) => Response | Promise<Response>;

/** An Arbis route module: receives the existing server's handler and returns its routes. */
export type ArbisRouteFactory = (upstream: UpstreamFetch) => Hono;

/** Add new Arbis APIs here; nothing in the existing server needs to change per route. */
export const arbisRouteRegistry: ArbisRouteFactory[] = [(upstream) => createArbisConnectRoutes(upstream)];

/**
 * Builds a Hono app with only the registered Arbis routes. Mount it before the existing
 * catch-all; unmatched requests fall through to the next handler untouched.
 */
export function createArbisApp(upstream: UpstreamFetch): Hono {
  const app = new HonoApp();
  for (const factory of arbisRouteRegistry) app.route("/", factory(upstream));
  return app;
}
