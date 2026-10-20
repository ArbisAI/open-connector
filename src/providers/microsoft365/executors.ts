import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { microsoftProfile } from "../../oauth/microsoft-profile.ts";

export const executors: ProviderExecutors = {};
export const credentialValidators: CredentialValidators = {
  async oauth2(input, options) {
    if (!input.refreshToken)
      throw new Error("Microsoft did not grant continued access. Reconnect and approve the requested permissions.");
    return { profile: await microsoftProfile(input, options) };
  },
};
