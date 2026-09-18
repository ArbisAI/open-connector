import type { UserConnectionStore } from "./user-connection-store.ts";

import { Hono } from "hono";
import { requiredString } from "../../core/cast.ts";
import { HttpRequestError, readJsonBody } from "../api/http-utils.ts";
import { writeRuntimeFailure, writeRuntimeSuccess } from "../api/runtime-api.ts";

interface UserConnectionRoutesOptions {
  userConnectionStore: UserConnectionStore;
}

/** Application-side user-to-connection-service mapping. Independent of the runtime's own connection ownership. */
export function createUserConnectionRoutes({ userConnectionStore }: UserConnectionRoutesOptions): Hono {
  const app = new Hono();

  app.get("/users/connectors", async (context) => {
    const userId = requiredString(
      context.req.query("userId"),
      "userId",
      (message) => new HttpRequestError("invalid_input", message),
    );
    return writeRuntimeSuccess(context, await userConnectionStore.listByUser(userId));
  });

  app.post("/users/connectors", async (context) => {
    const body = await readJsonBody(context);
    const userId = requiredString(body.userId, "userId", (message) => new HttpRequestError("invalid_input", message));
    const connectionService = requiredString(
      body.connectionService,
      "connectionService",
      (message) => new HttpRequestError("invalid_input", message),
    );
    return writeRuntimeSuccess(context, await userConnectionStore.upsert(userId, connectionService));
  });

  app.delete("/users/connectors/:id", async (context) => {
    const id = requiredString(
      context.req.param("id"),
      "id",
      (message) => new HttpRequestError("invalid_input", message),
    );
    const mapping = await userConnectionStore.find(id);
    if (!mapping)
      return writeRuntimeFailure(context, {
        status: 404,
        errorCode: "user_connection_not_found",
        message: `No connection mapping with id "${id}".`,
      });
    await userConnectionStore.delete(id);
    return writeRuntimeSuccess(context, null);
  });

  return app;
}
