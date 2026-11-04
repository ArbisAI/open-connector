import type { ProviderDefinition } from "../../core/types.ts";

import { mercadoPagoActions } from "./actions.ts";
import { snapshot as triggerSnapshot0_0 } from "./trigger-on-event.definition.ts";
import { triggerPermissions } from "./trigger-permissions.ts";

const service = "mercadopago";

/**
 * Mercado Pago provider for Mexico (site MLM).
 *
 * Sellers paste an access token, or connect with their own OAuth application.
 * Amounts are decimal major units, never centavos.
 *
 * What stays out, and why, is documented at the top of actions.ts. Do not add
 * card charges, saved cards, Point, in-store QR, payouts, SPEI disbursements,
 * Wallet Connect, dispute uploads, or marketplace fee splits without reading that note.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Mercado Pago",
  categories: ["Finance"],
  authTypes: ["api_key", "oauth2"],
  auth: [
    {
      type: "api_key",
      label: "Access Token",
      placeholder: "APP_USR-...",
      description:
        "Mercado Pago access token sent as a Bearer token. Copy it from Your integrations: https://www.mercadopago.com.mx/developers/panel/app. Mexico accounts only.",
      extraFields: [
        {
          key: "webhookSecret",
          label: "Webhook secret",
          inputType: "password",
          required: false,
          secret: true,
          placeholder: "webhook secret",
          description:
            "Secret from Your integrations > Webhooks. Required only to receive Mercado Pago notifications. Actions work without it.",
        },
      ],
    },
    {
      type: "oauth2",
      authorizationUrl: "https://auth.mercadopago.com/authorization",
      tokenUrl: "https://api.mercadopago.com/oauth/token",
      scopes: ["read", "write", "offline_access"],
      tokenEndpointAuthMethod: "client_secret_post",
      pkce: { method: "S256" },
    },
  ],
  homepageUrl: "https://www.mercadopago.com.mx",
  iconUrl: "https://http2.mlstatic.com/frontend-assets/mp-web-navigation/ui-navigation/7.8.2/mercadopago/favicon.svg",
  actions: mercadoPagoActions,
  triggers: [triggerSnapshot0_0],
  triggerPermissions,
};
