# Programmatic connections

The `/v1/connections` and `/v1/connection-requests` endpoints provide personal connection
management through the same HTTP paths and envelopes as OOMOL Hosted Connector. They support
OAuth authorization, polling one authorization attempt, connection details, and synchronous
API-key or custom-credential creation and replacement.

## SaaS OAuth sources

For a service configured with a SaaS source, the connection endpoints below authorize remotely
without a local OAuth client. Reconnecting an existing connection retains its source.
Read the four setup fields inside oauthClient: SaaS sets customClientAvailable to false,
uses its callback URL and requires no local client fields. Send no OAuth overrides in SaaS mode.

An explicit valid administrator Bearer GET synchronizes a known SaaS request; cookie-only GET
does not. Poll at least two seconds apart and honor Retry-After. Browser clients use the protected
same-origin POST described in [SaaS OAuth](saas-oauth.md#programmatic-authorization).
Never replay link creation after an unknown result. Completed connections use the same execution
selectors and policies, with provider credentials and execution remaining on SaaS.

## Authentication

Use the local administrator bearer token (`OOMOL_CONNECT_ADMIN_TOKEN`) to manage connections.
Execution-only runtime tokens and runtime JWTs do not grant management access. A fresh instance
with neither administrator nor runtime authentication configured accepts local management
requests without a token. Once runtime authentication is configured, configure an administrator
token before using these endpoints.

The open runtime has one administrator identity; its bearer token and authenticated console
session act as that same identity. It does not require Hosted Team headers. Hosted deployments
apply their own user and Team management permissions.

`GET /v1/apps` remains execution discovery and applies execution access policies.
`GET /v1/connections` returns the administrator's stored connections, including connections
hidden from execution discovery. It excludes virtual no-auth and Marketplace entries.

## Discover setup requirements

`GET /v1/providers/:service/setup` describes what a provider needs before it can be connected:
the credential fields of each supported credential type, the OAuth client inputs, the default
scopes (`scopes`), the additional scopes available for explicit selection (`optionalScopes`),
the provider's registration steps, the callback URL to register, and which OAuth client inputs
are still missing. It never returns saved values, so a host can build its own connection form
from it and submit through the endpoints below.

`authMethods` is the application-facing summary. Each entry includes `type`, `configured`,
`unavailableReason`, and `fields`. For OAuth, `configured` means that the provider application is
ready on this OpenConnector deployment; it does not mean that an end user has authorized an
account. API-key and custom-credential fields include stable keys, labels, input hints, required
and secret flags, and provider help text where declared.

The lower-level `auth` array contains complete provider metadata, including scopes and OAuth
registration instructions. `oauthClient` reports the callback to register and missing provider-app
configuration, but never returns saved client secrets.

```json
{
  "service": "notion",
  "authMethods": [
    {
      "type": "oauth",
      "configured": false,
      "unavailableReason": "OAuth application is not configured.",
      "fields": []
    },
    {
      "type": "api_key",
      "configured": true,
      "unavailableReason": null,
      "fields": [
        {
          "key": "apiKey",
          "label": "Internal Integration Secret",
          "inputType": "password",
          "required": true,
          "secret": true
        }
      ]
    }
  ]
}
```

## Start and track OAuth

For local OAuth, configure your provider's OAuth client through the console or
`/api/oauth/configs/:service` first. Register `/oauth/callback` on this runtime as the callback URL.

Omit `requestedScopes` to request every default scope and no optional scopes. When provided,
`requestedScopes` replaces the default scope list: only the listed scopes are requested, and
each must appear in the provider's `scopes` or `optionalScopes`. Include any identity scopes
needed by the provider's credential validator; defaults are not added automatically.

For example, a Google Calendar OAuth client config for editing events, listing calendars, and
querying availability can use:

```json
{
  "clientId": "your-google-client-id",
  "clientSecret": "your-google-client-secret",
  "requestedScopes": [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy"
  ]
}
```

This config omits `calendar.readonly` and all other unlisted default scopes. Choose scopes
that grant the minimum access needed for your application's features.

For SaaS OAuth, configure the cloud project and select the provider configuration instead.
The provider's OAuth callback is hosted by SaaS; after authorization, SaaS returns to a
Connect-generated `/oauth/saas/complete` URL. The final `returnUri` stays in Connect and is
used after synchronization, rather than being passed to SaaS.

```sh
curl -sS -X POST http://localhost:3000/v1/connections/github/connect \
  -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

The success envelope contains:

```json
{
  "success": true,
  "message": "OK",
  "data": {
    "authorizationUrl": "https://github.com/login/oauth/authorize?...",
    "stateHandle": "oauth-state-id",
    "connectionRequestId": "request-id",
    "status": "initiated",
    "expiresAt": "2026-09-07T10:10:00.000Z"
  },
  "meta": {}
}
```

Open `authorizationUrl` in a browser and save `connectionRequestId`. The state handle belongs
to the OAuth callback and is not the result-query identifier.

```sh
curl -sS http://localhost:3000/v1/connection-requests/request-id \
  -H "Authorization: Bearer $OOMOL_CONNECT_ADMIN_TOKEN"
```

The result's `data` has `connectionRequestId`, `service`, `status`, `appId`, `errorCode`,
`errorMessage`, `expiresAt`, `createdAt`, and `updatedAt`. Creation and update times are Unix
milliseconds; `expiresAt` is an ISO timestamp. `appId` and the error fields are nullable.

| Status      | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| `initiated` | Authorization has not reached a terminal result. Poll again, for example after two seconds. |
| `connected` | This attempt saved its connection. Use its exact `appId` and stop polling.                  |
| `failed`    | Authorization failed or was denied. Inspect the safe error fields and stop polling.         |
| `expired`   | The ten-minute authorization window elapsed without a terminal result.                      |

A callback must begin before `expiresAt`. A callback already processing may finish after that
time and change an expired view to a connected or failed result. Success and failure remain
queryable until `expiresAt` plus 24 hours. Missing or expired-retention results return HTTP 404
with `connection_request_not_found`. Results use `Cache-Control: private, no-store` and never
include credentials or raw provider errors.

Starting another request for the same provider supersedes earlier requests that have not
started processing, returning `failed` with `request_superseded`. A callback already processing
continues. Repeated callbacks do not overwrite terminal results.

OAuth inputs can include:

- `returnUri`: optional `http:`, `https:`, or `oomol:` URL. The callback adds `status` and `service`,
  and safe `code` and `message` fields on failure.
- `authorizationOptionIds` (local OAuth only): provider-declared option IDs. GitHub and Slack expose selectable
  provider-native scopes in their OAuth definitions. Required options are always included.
  Omission preserves the configured scopes; unknown options or options on unsupported providers
  return `invalid_input`. `requires` describes selection dependencies for clients; the server
  preserves the explicitly selected options and required options.
- `extra` and `secretExtra` (local OAuth only): provider-declared OAuth configuration fields, merged for this
  authorization attempt without changing the saved client configuration.

## Inspect and reconnect

```http
GET /v1/connections
GET /v1/connections?status=active
GET /v1/connections/by-id/:appId
POST /v1/connections/by-id/:appId/connect
```

A successful OAuth request records the outcome of that attempt. Query connection details for
its current state. An expired OAuth credential with no refresh token reports `reauth_required`.

Reconnection takes the same OAuth body and returns a new request ID. Success keeps the original
`appId`. If the original connection is deleted or its credentials change during authorization,
the stale callback fails instead of recreating it or overwriting the replacement.

New connections receive distinct local aliases. Use the returned `alias` as the connection
selector when executing actions. Existing local default-connection selection remains available.

### Exact alias lookup and recovery

Use `GET /v1/connections/by-alias/:service/:alias` to resolve one exact connection. The lookup is
administrator-only, returns safe connection metadata without credentials, and does not enumerate
other connections or fall back to a provider default. A missing provider/alias pair returns 404
with `app_not_found`.

Hosts that coordinate a local ownership record with OpenConnector should generate and persist a
unique alias before creating the remote connection. If the create response is lost, resolve that
exact alias before deciding whether another create is safe. Do not treat an authentication error,
timeout, or generic unavailable response as proof that the first connection was not created.

## API keys and custom credentials

These operations validate and save credentials synchronously. They return the connection in the
success envelope and do not require polling.

```http
POST /v1/connections/:service/connect/api-key
POST /v1/connections/by-id/:appId/connect/api-key
```

Body: `{ "apiKey": "...", "extra": { "field": "value" }, "comment": "Optional note" }`.
`extra` and `comment` are optional.

Creation also accepts `connectionName` as the stable alias. Replacement is addressed by exact
`appId`; a supplied alias must match the selected connection. Invalid credentials do not discard
the previous stored credential, and concurrent replacements do not overwrite a newer winner.

```http
POST /v1/connections/:service/connect/custom-credential
POST /v1/connections/by-id/:appId/connect/custom-credential
```

Body: `{ "values": { "field": "value" }, "comment": "Optional note" }`.
`comment` is optional; use `null` to clear an existing note. Replacement retains the connection
ID, requires the existing credential type, and does not discard existing credentials when
validation fails or a concurrent update wins.

The OpenAPI document at `/openapi.json` describes the request and response envelopes. The local
console's `/api/connections` and `/api/oauth/authorizations` endpoints continue to work.

## Persistence

Migration `0013_connection_requests.sql` stores authorization attempts on SQLite, PostgreSQL,
and Cloudflare D1. SQLite applies it through the existing startup migrations. PostgreSQL and D1
use their existing deployment migration commands; migrate before starting the new runtime.

The pending OAuth snapshot uses the configured secret codec and participates in secret rotation.
A connection write and its successful request result commit together. D1 uses transactional
[`batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) for these writes;
SQLite and PostgreSQL use their native transactions. Expired retained records are cleaned up
when new requests are created.

## Verification

Run the focused setup and connection-management contract tests:

```bash
node node_modules/vitest/vitest.mjs run src/server/api/setup-contract.test.ts src/server/api/connection-routes.test.ts
```

These tests cover authentication-method metadata, secret-free responses, exact alias lookup,
API-key creation and replacement, validation failure, concurrent replacement, disconnect, OAuth
request tracking, and management-token enforcement. Provider-specific acceptance still needs a
real provider account and must verify the scopes and resources available to that credential.
