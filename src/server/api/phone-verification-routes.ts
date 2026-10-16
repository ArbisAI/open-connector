import type { ConnectionService } from "../../connection-service.ts";

import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { optionalRecord, optionalString } from "../../core/cast.ts";
import { readJsonBody } from "./http-utils.ts";
import { writeRuntimeFailure, writeRuntimeSuccess } from "./runtime-api.ts";

interface PhoneVerificationOptions {
  connections: ConnectionService;
  fetcher?: typeof fetch;
}

/** Service-only Verify calls. No catalog discovery, action logs, or raw provider errors. */
export function createPhoneVerificationRoutes({ connections, fetcher = fetch }: PhoneVerificationOptions): Hono {
  const app = new Hono();
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    const expected = Buffer.from(process.env.PHONE_VERIFY_INTERNAL_TOKEN || "");
    const supplied = Buffer.from(context.req.header("Authorization")?.replace(/^Bearer /, "") || "");
    if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      return writeRuntimeFailure(context, {
        status: 401,
        errorCode: "unauthorized",
        message: "Invalid verification credentials.",
      });
    }
    await next();
  });
  app.post("/:operation", async (context) => {
    const operation = context.req.param("operation");
    if (!["start_phone_verification", "check_phone_verification"].includes(operation))
      return writeRuntimeFailure(context, {
        status: 404,
        errorCode: "not_found",
        message: "Unknown verification operation.",
      });
    const body = await readJsonBody(context, 2048);
    const input = optionalRecord(body.input);
    const connectionId = process.env.PHONE_VERIFY_CONNECTION_ID;
    const profileId = process.env.TELNYX_VERIFY_PROFILE_ID;
    if (!connectionId || !profileId)
      return writeRuntimeFailure(context, {
        status: 503,
        errorCode: "unavailable",
        message: "Phone verification is not configured.",
      });
    const start = operation === "start_phone_verification";
    const number = optionalString(input?.phoneNumber) || "";
    const id = optionalString(input?.id) || "";
    const code = optionalString(input?.code) || "";
    if (
      (start && !/^\+[1-9][0-9]{7,14}$/.test(number)) ||
      (!start && (!/^[a-f0-9-]{36}$/i.test(id) || !/^[0-9]{4,10}$/.test(code)))
    )
      return writeRuntimeFailure(context, {
        status: 400,
        errorCode: "invalid_input",
        message: "Invalid verification request.",
      });
    try {
      const resolved = await connections.resolveForExecution("telnyx", undefined, connectionId);
      const credential = resolved.kind === "local" ? await resolved.getCredential("telnyx") : undefined;
      if (credential?.authType !== "api_key") throw new Error("Unavailable");
      const response = await fetcher(
        `https://api.telnyx.com/v2/verifications/${start ? "sms" : `${encodeURIComponent(id)}/actions/verify`}`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(
            start ? { phone_number: number, verify_profile_id: profileId, timeout_secs: 300 } : { code },
          ),
        },
      );
      if (!response.ok) {
        if (!start && [400, 404, 422].includes(response.status))
          return writeRuntimeSuccess(context, { accepted: false });
        throw new Error("Provider unavailable");
      }
      const data = optionalRecord(optionalRecord(await response.json())?.data);
      if (!start) return writeRuntimeSuccess(context, { accepted: data?.response_code === "accepted" });
      const verificationId = optionalString(data?.id);
      if (!verificationId) throw new Error("Invalid response");
      return writeRuntimeSuccess(context, { id: verificationId });
    } catch {
      return writeRuntimeFailure(context, {
        status: 503,
        errorCode: "unavailable",
        message: "Phone verification is temporarily unavailable.",
      });
    }
  });
  return app;
}
