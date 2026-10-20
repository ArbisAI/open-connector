import type { ProviderDefinition } from "../../core/types.ts";

const microsoftScopes: string[] = [
  "openid",
  "profile",
  "User.Read",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
];

/** Consent broker; actions execute through Outlook Email and Outlook Calendar. */
export const provider: ProviderDefinition = {
  service: "microsoft365",
  displayName: "Microsoft email and calendar",
  categories: ["Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: microsoftScopes,
      pkce: { method: "S256" },
      authorizationParams: { response_mode: "query", prompt: "select_account" },
      authorizationOptions: microsoftScopes.map((id) => ({
        id,
        label: id,
        description: "Microsoft account permission",
        required: id === "User.Read",
        defaultSelected: true,
        risk: "standard",
      })),
      clientConfigFields: [
        {
          key: "tenant",
          label: "Tenant",
          inputType: "text",
          required: true,
          secret: false,
          defaultValue: "common",
        },
      ],
    },
  ],
  actions: [],
};
