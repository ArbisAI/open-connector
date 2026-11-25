import type { ProviderProxyExecutor } from "../../core/types.ts";

import { optionalRecord, optionalString } from "../../core/cast.ts";
import { readBoundedResponseBytes } from "../../core/request.ts";
import {
  providerFetch,
  ProviderRequestError,
  readProviderJsonBody,
  requireApiKeyCredential,
  runProviderRequest,
  toProviderProxyError,
} from "../provider-runtime.ts";
import { whatsappGraphApiBaseUrl, whatsappGraphApiVersion } from "./runtime.ts";

const maxBytes = 10 * 1024 * 1024;

/** Used only by the binary HTTP route, never by JSON actions or the public proxy. */
export const downloadWhatsAppAudio: ProviderProxyExecutor = async (input, context) => {
  try {
    const mediaId = input.endpoint.slice(1);
    const phoneNumberId = optionalString(input.query?.phone_number_id);
    if (!/^\d{1,128}$/.test(mediaId) || !phoneNumberId || !/^\d{1,128}$/.test(phoneNumberId)) {
      throw new ProviderRequestError(400, "A media ID and receiving phone number ID are required.");
    }
    const credential = await requireApiKeyCredential(context, "whatsapp");
    const headers = { Authorization: `Bearer ${credential.apiKey}` };
    return await runProviderRequest(
      { label: "WhatsApp audio", signal: context.signal, timeoutMs: 15000 },
      async (signal) => {
        const metadataResponse = await providerFetch(
          `${whatsappGraphApiBaseUrl}/${whatsappGraphApiVersion}/${mediaId}?phone_number_id=${phoneNumberId}`,
          {
            headers,
            signal,
            redirect: "manual",
          },
        );
        if (!metadataResponse.ok) {
          await metadataResponse.body?.cancel();
          throw new ProviderRequestError(metadataResponse.status, "WhatsApp media lookup failed.");
        }
        const metadata = optionalRecord(
          await readProviderJsonBody(metadataResponse, {
            maxBytes: 64 * 1024,
            emptyBody: "error",
            invalidJsonMessage: "Invalid WhatsApp media metadata.",
          }),
        );
        const url = new URL(optionalString(metadata?.url) ?? "invalid");
        const mimeType = optionalString(metadata?.mime_type)?.split(";")[0]?.toLowerCase();
        if (!mimeType || !/^(audio\/(ogg|webm|mpeg|mp4|aac|amr|wav|flac)|application\/ogg)$/.test(mimeType)) {
          throw new ProviderRequestError(400, "WhatsApp media is not supported audio.");
        }
        if (typeof metadata?.file_size !== "number" || metadata.file_size <= 0 || metadata.file_size > maxBytes) {
          throw new ProviderRequestError(413, "WhatsApp audio exceeds the size limit.");
        }
        // A provider URL is still untrusted. Limit credential destinations and let providerFetch
        // enforce public DNS addresses. Redirects cannot forward this bearer credential elsewhere.
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.port ||
          !["fbsbx.com", "facebook.com", "whatsapp.net"].some(
            (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
          )
        ) {
          throw new ProviderRequestError(400, "Invalid WhatsApp media destination.");
        }
        const response = await providerFetch(url, { headers, signal, redirect: "manual" });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderRequestError(response.status, "WhatsApp audio download failed.");
        }
        const bytes = await readBoundedResponseBytes(response, {
          maxBytes,
          signal,
          fieldName: "WhatsApp audio",
          createError: () => new ProviderRequestError(413, "WhatsApp audio exceeds the size limit."),
        });
        if (!bytes.length) throw new ProviderRequestError(400, "WhatsApp audio is empty.");
        return { ok: true as const, response: { status: 200, headers: { "content-type": mimeType }, data: bytes } };
      },
    );
  } catch (error) {
    // Do not expose URLs, credentials, provider bodies, or audio in error details.
    return toProviderProxyError(
      new ProviderRequestError(
        error instanceof ProviderRequestError ? error.status : 502,
        "WhatsApp audio download failed.",
      ),
      "WhatsApp audio download failed.",
    );
  }
};
