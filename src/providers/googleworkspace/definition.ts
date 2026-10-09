import type { ProviderDefinition } from "../../core/types.ts";

export const workspaceScopes: string[] = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];

/** Consent broker only. Actions use the separately owned Gmail/Calendar connections. */
export const provider: ProviderDefinition = {
  service: "googleworkspace",
  displayName: "Google email and calendar",
  categories: ["Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: workspaceScopes,
      authorizationParams: { access_type: "offline", prompt: "consent" },
      authorizationOptions: workspaceScopes.map((id, i) => ({
        id,
        label: ["Identity", "Email address", "Profile", "Read email", "Read calendars", "Send email", "Edit events"][
          i
        ]!,
        description: "Optional Google permission. You can decline access and continue.",
        required: false,
        defaultSelected: i < 5,
        risk: i < 3 ? "standard" : "sensitive",
      })),
    },
  ],
  actions: [],
};
