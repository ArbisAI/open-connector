import type { CatalogStore } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary, ExecutionConnection } from "../../connection-service.ts";
import type { ActionPolicyDecision, ActionPolicySnapshot } from "../../core/action-policy.ts";
import type { ProviderHttpDispatchOptions } from "../../core/provider-http-dispatch.ts";
import type { RuntimeLogger, ExecutionContext, ExecutionResult, TransitFileWriter } from "../../core/types.ts";
import type { MarketplaceService } from "../../marketplace/marketplace-service.ts";
import type { PreparedAction } from "../../providers/approval.ts";
import type { IProviderLoader } from "../../providers/provider-loader.ts";
import type { SaasExecutionService } from "../../saas/saas-execution-service.ts";
import type { IRunLogStore, RunLog, RunLogCaller, RunLogListInput, RunLogPage } from "../storage/runtime-store.ts";

import { ConnectionError } from "../../connection-service.ts";
import { executeAction as executeProviderAction } from "../../core/execution.ts";
import { withProviderHttpDispatch } from "../../core/provider-http-dispatch.ts";
import { approvalInputHash, supportsPreparedAction } from "../../providers/approval.ts";
import {
  ProviderDispatchRequestError,
  toProviderExecutionError,
  withProviderHttpDispatchResult,
} from "../../providers/provider-runtime.ts";
import { SaasError } from "../../saas/saas-client.ts";
import { buildActionPreview, resolvePreviewFolders } from "./action-preview.ts";
import { safeRunLogError, summarizeForRunLog } from "./run-log-summary.ts";

export interface ActionRunnerOptions {
  providerHttpDispatch?: ProviderHttpDispatchOptions;
  catalog: CatalogStore;
  providerLoader: IProviderLoader;
  connections: ConnectionService;
  runs: IRunLogStore;
  transitFiles?: TransitFileWriter;
  logger?: RuntimeLogger;
  marketplace?: MarketplaceService;
  saas?: SaasExecutionService;
}

export interface RunActionInput {
  actionId: string;
  input: unknown;
  prepare?: boolean;
  prepared?: PreparedAction;
  caller: RunLogCaller;
  connectionName?: string;
  connectionId?: string;
  policy: ActionPolicySnapshot;
  runtimeTokenId?: string;
  signal?: AbortSignal;
}

export interface ActionRunResult {
  executionId: string;
  auditPersisted: boolean;
  remoteExecutionId?: string;
  failureStatus?: SaasError["status"];
  retryAfter?: string;
  result: ExecutionResult;
  connection?: ConnectionSummary;
}

/**
 * Shared execution boundary for HTTP, MCP, and future local callers.
 */
export class ActionRunner {
  private readonly options: ActionRunnerOptions;

  constructor(options: ActionRunnerOptions) {
    this.options = options;
  }

  async run(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    return withProviderHttpDispatch(
      { operation: "action", service: action?.service, actionId: action?.id },
      () => this.runAction(input),
      this.options.providerHttpDispatch,
    );
  }

  async prepare(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const run = await this.run({ ...input, prepare: true });
    if (!run?.result.ok) return run;
    const action = this.options.catalog.actionsById.get(input.actionId)!;
    const prepared = run.result.output as PreparedAction;
    const fields = input.input as Record<string, unknown>;
    const reference =
      action.service === "googlecalendar" && fields.eventId
        ? {
            actionId: "googlecalendar.get_event",
            input: { calendarId: fields.calendarId ?? "primary", eventId: fields.eventId },
          }
        : action.service === "googledrive" && fields.fileId
          ? { actionId: "googledrive.files.get", input: { fileId: fields.fileId } }
          : action.service === "notion" && fields.pageId
            ? { actionId: "notion.retrieve_page", input: { pageId: fields.pageId } }
            : action.service === "notion" && fields.blockId
              ? { actionId: "notion.retrieve_block", input: { blockId: fields.blockId } }
              : undefined;
    let current: unknown;
    if (reference && action.service === "googlecalendar") {
      const saved = prepared.reads.find((read) =>
        new URL(read.url).pathname.endsWith(`/events/${encodeURIComponent(String(fields.eventId))}`),
      );
      if (saved) current = JSON.parse(Buffer.from(saved.bodyBase64, "base64").toString("utf8"));
    }
    if (current === undefined && reference && this.options.catalog.actionsById.has(reference.actionId)) {
      const read = await this.run({ ...input, ...reference, prepare: false, prepared: undefined });
      if (read?.result.ok) current = read.result.output;
    }
    if (
      action.service === "googlecalendar" &&
      ["googlecalendar.update_event", "googlecalendar.patch_event"].includes(action.id) &&
      prepared.request
    ) {
      const etag = (current as { etag?: string } | undefined)?.etag;
      if (etag) prepared.request.headers["if-match"] = etag;
    }
    const preview = await buildActionPreview(action, run.connection, input.input, prepared, current);
    if (this.options.catalog.actionsById.has("googledrive.files.get")) {
      await resolvePreviewFolders(preview, async (fileId) => {
        const read = await this.run({
          ...input,
          connectionId: run.connection?.id ?? input.connectionId,
          actionId: "googledrive.files.get",
          input: { fileId, fields: "id,name,mimeType" },
          prepare: false,
          prepared: undefined,
        });
        return read?.result.ok ? read.result.output : undefined;
      });
    }
    return { ...run, result: { ok: true, output: { prepared, preview } } };
  }

  private async runAction(input: RunActionInput): Promise<ActionRunResult | undefined> {
    const action = this.options.catalog.actionsById.get(input.actionId);
    if (!action) {
      this.options.logger?.warn(
        {
          actionId: input.actionId,
          caller: input.caller,
          errorCode: "unknown_action",
        },
        "action run rejected",
      );
      return undefined;
    }

    const executionId = crypto.randomUUID();
    const logContext = {
      actionId: action.id,
      service: action.service,
      caller: input.caller,
      executionId,
    };
    this.options.logger?.info(logContext, "action run started");
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let policy: ActionPolicyDecision = input.policy.evaluate(action);
    let connection: ExecutionConnection | undefined;
    let result: ExecutionResult;
    let remoteExecutionId: string | undefined;
    let failureStatus: SaasError["status"] | undefined;
    let retryAfter: string | undefined;
    if (!policy.allowed) {
      result = { ok: false, error: { code: policy.code, message: policy.message } };
    } else if (input.signal?.aborted) {
      result = cancelledExecutionResult();
    } else {
      try {
        const summary = await this.options.connections.getConnectionSummary(
          action.service,
          input.connectionName,
          input.connectionId,
        );
        input.signal?.throwIfAborted();
        const connectionPolicy =
          summary?.authType === "no_auth" ? undefined : input.policy.evaluateConnection(summary?.id);
        if (connectionPolicy && !connectionPolicy.allowed) {
          policy = connectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else if (summary?.authType === "marketplace" && !this.options.marketplace?.supportsAction(action.id)) {
          result = {
            ok: false,
            error: {
              code: "connection_not_found",
              message: "The selected Marketplace connection does not support this action.",
            },
          };
        } else {
          connection = await this.options.connections.resolveForExecution(
            action.service,
            input.connectionName,
            input.connectionId,
          );
          input.signal?.throwIfAborted();
          const targetPolicy =
            connection.summary?.authType === "no_auth"
              ? undefined
              : input.policy.evaluateConnection(connection.summary?.id);
          if (targetPolicy && !targetPolicy.allowed) {
            policy = targetPolicy;
            throw new ConnectionError(targetPolicy.code, targetPolicy.message);
          }
          const executor =
            action.execution.locallyExecutable && connection.kind === "local"
              ? await this.options.providerLoader.loadActionExecutor(
                  action.service,
                  action.id,
                  this.options.catalog.providers.find((provider) => provider.service === action.service)?.displayName,
                )
              : undefined;
          input.signal?.throwIfAborted();
          const saasReference = connection.kind === "saas" ? connection.reference : undefined;
          const resolvedConnection = connection;
          if (
            input.prepared &&
            (input.prepared.version !== 1 ||
              input.prepared.actionId !== action.id ||
              input.prepared.connectionId !== connection.summary?.id ||
              input.prepared.inputHash !== approvalInputHash(input.input))
          ) {
            return {
              executionId,
              auditPersisted: false,
              result: {
                ok: false,
                error: {
                  code: "approval_expired",
                  message: "The saved approval no longer matches this action.",
                  details: { outcome: "not_executed" },
                },
              },
            };
          }
          result = await withProviderHttpDispatchResult(
            {
              operation: "action",
              service: action.service,
              actionId: action.id,
              executionId,
              connectionId: connection.summary?.id,
              connectionName: connection.summary?.connectionName,
            },
            () =>
              executeProviderAction(
                action,
                input.prepare &&
                  ((executor && !supportsPreparedAction(action.id)) || resolvedConnection.kind !== "local")
                  ? async () => ({ ok: true, output: { reads: [] } })
                  : saasReference
                    ? async (actionInput) => {
                        if (!this.options.saas)
                          throw new SaasError("oauth_source_unavailable", "SaaS execution is unavailable.", 503);
                        const remote = await this.options.saas.executeAction(
                          saasReference,
                          action.service,
                          action.id,
                          actionInput,
                          input.signal,
                        );
                        remoteExecutionId = remote.executionId;
                        return { ok: true, output: remote.output };
                      }
                    : resolvedConnection.kind === "marketplace"
                      ? (actionInput) => this.options.marketplace!.execute(action.id, actionInput, input.signal)
                      : executor,
                input.input,
                {
                  ...this.createExecutionContext(
                    resolvedConnection.kind === "local" ? resolvedConnection.getCredential : async () => undefined,
                    input.signal,
                  ),
                  approval: input.prepare
                    ? { mode: "prepare", actionId: action.id }
                    : input.prepared
                      ? { mode: "execute", prepared: input.prepared }
                      : undefined,
                },
              ),
            this.options.providerHttpDispatch,
          );
          if (input.signal?.aborted) {
            result = cancelledExecutionResult();
          }
        }
      } catch (error) {
        const missingConnectionPolicy =
          error instanceof ConnectionError && error.code === "connection_not_found"
            ? input.policy.evaluateConnection()
            : undefined;
        if (input.signal?.aborted) {
          result = cancelledExecutionResult();
        } else if (missingConnectionPolicy && !missingConnectionPolicy.allowed) {
          policy = missingConnectionPolicy;
          result = { ok: false, error: { code: policy.code, message: policy.message } };
        } else if (error instanceof SaasError) {
          remoteExecutionId = error.remoteExecutionId;
          failureStatus = error.status;
          retryAfter = error.retryAfter;
          result = { ok: false, error: { code: error.code, message: error.message } };
        } else if (error instanceof ProviderDispatchRequestError) {
          result = toProviderExecutionError(error, error.message);
        } else {
          result =
            error instanceof ConnectionError
              ? { ok: false, error: { code: error.code, message: error.message } }
              : {
                  ok: false,
                  error: { code: "internal_error", message: "Action execution failed unexpectedly." },
                };
        }
      }
    }
    if (input.prepare) {
      if (result.ok)
        result = {
          ok: true,
          output: {
            ...(result.output as object),
            version: 1,
            actionId: action.id,
            connectionId: connection?.summary?.id ?? "",
            inputHash: approvalInputHash(input.input),
          },
        };
      return { executionId, auditPersisted: false, result, connection: connection?.summary };
    }
    const completedAtMs = Date.now();
    const durationMs = completedAtMs - startedAtMs;
    const auditError = safeRunLogError(result.error);
    const runLog: RunLog = {
      id: executionId,
      remoteExecutionId,
      service: action.service,
      actionId: input.actionId,
      caller: input.caller,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs,
      ok: result.ok,
      connectionId: connection?.summary?.id,
      connectionProfile: connection?.summary?.profile,
      runtimeTokenId: input.runtimeTokenId,
      policy,
      inputSummary: summarizeForRunLog(input.input),
      outputSummary: result.ok ? summarizeForRunLog(result.output) : undefined,
      ...auditError,
    };

    let auditPersisted = false;
    try {
      const write = await this.options.runs.add(runLog);
      auditPersisted = true;
      if (!write.retentionApplied) {
        this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit retention failed");
      }
    } catch {
      this.options.logger?.warn({ ...logContext, auditPersisted }, "run audit persistence failed");
    }

    const completedLogContext = {
      ...logContext,
      remoteExecutionId,
      connectionId: connection?.summary?.id,
      durationMs,
      ok: result.ok,
      errorCode: result.error?.code,
      auditPersisted,
    };
    if (result.ok) {
      this.options.logger?.info(completedLogContext, "action run completed");
    } else if (result.error?.code === "execution_cancelled") {
      this.options.logger?.info(completedLogContext, "action run cancelled");
    } else {
      this.options.logger?.warn(completedLogContext, "action run failed");
    }

    return {
      executionId,
      remoteExecutionId,
      failureStatus,
      retryAfter,
      auditPersisted,
      result,
      connection: connection?.summary,
    };
  }

  listRuns(input?: RunLogListInput): Promise<RunLogPage> {
    return this.options.runs.list(input);
  }

  getRun(id: string): Promise<RunLog | undefined> {
    return this.options.runs.get(id);
  }

  private createExecutionContext(
    getCredential: ExecutionContext["getCredential"],
    signal: AbortSignal | undefined,
  ): ExecutionContext {
    const context: ExecutionContext = {
      getCredential,
      signal,
      logger: this.options.logger,
    };
    if (this.options.transitFiles) {
      context.transitFiles = this.options.transitFiles;
    }
    return context;
  }
}

function cancelledExecutionResult(): ExecutionResult {
  return {
    ok: false,
    error: {
      code: "execution_cancelled",
      message: "Action execution was cancelled.",
    },
  };
}
