import type { UserConnectionStore } from "./user-connection-store.ts";
import type { Context } from "hono";

import { Hono } from "hono";
import { optionalString, requiredString } from "../../core/cast.ts";
import { HttpRequestError, readJsonBody } from "../api/http-utils.ts";
import { writeRuntimeSuccess } from "../api/runtime-api.ts";

const userHeader = "x-arbis-user-id";

interface UserConnectionRoutesOptions {
  userConnectionStore: UserConnectionStore;
}

/**
 * Application-side user-to-provider mapping.
 * The caller is the Arbis user id in `x-arbis-user-id`. A userId in the query or body must match that header.
 */
export function createUserConnectionRoutes({ userConnectionStore }: UserConnectionRoutesOptions): Hono {
  const app = new Hono();

  app.get("/users/connectors", async (context) => {
    const userId = callerUserId(context);
    assertSameUser(optionalString(context.req.query("userId")), userId);
    return writeRuntimeSuccess(context, await userConnectionStore.listByUser(userId));
  });

  app.post("/users/connectors", async (context) => {
    const userId = callerUserId(context);
    const body = await readJsonBody(context);
    assertSameUser(optionalString(body.userId), userId);
    const connectionService = requiredString(
      body.connectionService,
      "connectionService",
      (message) => new HttpRequestError("invalid_input", message),
    );
    return writeRuntimeSuccess(context, await userConnectionStore.upsert(userId, connectionService));
  });

  app.delete("/users/connectors/:id", async (context) => {
    const userId = callerUserId(context);
    const id = requiredString(
      context.req.param("id"),
      "id",
      (message) => new HttpRequestError("invalid_input", message),
    );
    const mapping = await userConnectionStore.find(id);
    if (!mapping || mapping.userId !== userId) {
      throw new HttpRequestError("user_connection_not_found", `No connection mapping with id "${id}".`, 404);
    }
    await userConnectionStore.delete(id);
    return writeRuntimeSuccess(context, null);
  });

  return app;
}

function callerUserId(context: Context): string {
  return requiredString(
    context.req.header(userHeader),
    userHeader,
    (message) => new HttpRequestError("invalid_input", message),
  );
}

function assertSameUser(claimed: string | undefined, caller: string): void {
  if (claimed !== undefined && claimed !== caller) {
    throw new HttpRequestError("forbidden", "userId does not match x-arbis-user-id.", 403);
  }
}
