# WhatsApp audio download

`POST /v1/media/whatsapp/audio` downloads a voice recording for a backend transcription worker. It requires the runtime bearer token and an explicit `x-oo-connector-app-id` header. The JSON request contains `media_id` and `phone_number_id`.

The route reuses proxy policy, connection permissions and current company authorization. It resolves the selected local WhatsApp API-key connection, asks Meta for the media URL with `phone_number_id` to check ownership, and downloads through guarded public-network fetch. Only HTTPS Meta destinations are accepted; redirects are rejected to prevent bearer-token disclosure. It never accepts a client URL.

The runtime admits four audio downloads at a time; additional requests receive HTTP 429. A successful response is raw audio with the provider MIME type and `Cache-Control: no-store`. The body is buffered with a 10 MB streaming read limit and a 15-second provider deadline. Caller cancellation reaches the upstream requests. No transit file or action result is created. Provider errors contain no audio, access tokens or temporary URLs.

SaaS-managed and marketplace credentials are not supported by this binary route; they return an explicit error. Ordinary JSON proxy and action responses are unchanged. The server-owned `localExecutor` option is internal and cannot be supplied through a public proxy request body.

Tests cover runtime authentication, binary response shape, absence of action logs, policy denial, phone binding, download destination checks, streamed byte limits and incompatible remote transports. Existing server/proxy regression suites are included. Actual Meta audio and the target connection must still be verified in development before enabling the consuming feature.

[Meta documents the phone-number ownership parameter](https://www.postman.com/meta/whatsapp-business-platform/request/ptjyi84/retrieve-media-url).

The downloader is loaded through the selected provider registry, so builds that omit WhatsApp do not bundle its implementation. Redirects use manual handling and reject non-success responses, including 3xx, on both Node and Cloudflare Workers.
