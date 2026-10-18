import type { OAuthAuthorizationOption, ProviderDefinition } from "../../core/types.ts";

const optionalPermission = "Optional Google permission. You can decline access and continue.";

/**
 * The consent menu, declared option by option rather than derived from array
 * position. A caller names the scopes it wants in `authorizationOptionIds`, and
 * `startConnectionRequest` rejects any id missing from this list outright, so a
 * scope a host needs but this table omits fails the connect call rather than
 * quietly degrading to a narrower grant.
 *
 * `risk` follows Google's own classification: `calendar.events.freebusy` is a
 * non-sensitive scope, unlike the sensitive `calendar.readonly` it replaces for
 * availability lookups. `defaultSelected` is consent-chooser metadata only and
 * never widens a request that names its scopes explicitly; a newly added option
 * stays unselected so it cannot extend an existing host's consent screen.
 */
const workspaceScopeOptions: OAuthAuthorizationOption[] = [
  {
    id: "openid",
    label: "Identity",
    description: optionalPermission,
    required: false,
    defaultSelected: true,
    risk: "standard",
  },
  {
    id: "email",
    label: "Email address",
    description: optionalPermission,
    required: false,
    defaultSelected: true,
    risk: "standard",
  },
  {
    id: "profile",
    label: "Profile",
    description: optionalPermission,
    required: false,
    defaultSelected: true,
    risk: "standard",
  },
  {
    id: "https://www.googleapis.com/auth/gmail.readonly",
    label: "Read email",
    description: optionalPermission,
    required: false,
    defaultSelected: true,
    risk: "sensitive",
  },
  {
    id: "https://www.googleapis.com/auth/calendar.readonly",
    label: "Read calendars",
    description: optionalPermission,
    required: false,
    defaultSelected: true,
    risk: "sensitive",
  },
  {
    id: "https://www.googleapis.com/auth/gmail.send",
    label: "Send email",
    description: optionalPermission,
    required: false,
    defaultSelected: false,
    risk: "sensitive",
  },
  {
    id: "https://www.googleapis.com/auth/calendar.events",
    label: "Edit events",
    description: optionalPermission,
    required: false,
    defaultSelected: false,
    risk: "sensitive",
  },
  {
    id: "https://www.googleapis.com/auth/gmail.compose",
    label: "Create email drafts",
    description: optionalPermission,
    required: false,
    defaultSelected: false,
    risk: "sensitive",
  },
  {
    id: "https://www.googleapis.com/auth/calendar.events.freebusy",
    label: "Check calendar availability",
    description: optionalPermission,
    required: false,
    defaultSelected: false,
    risk: "standard",
  },
];

export const workspaceScopes: string[] = workspaceScopeOptions.map((option) => option.id);

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
      authorizationOptions: workspaceScopeOptions,
    },
  ],
  actions: [],
};
