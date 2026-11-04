import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { googleProfile } from "../../oauth/google-profile.ts";
export const executors: ProviderExecutors = {};
export const credentialValidators: CredentialValidators = {
  async oauth2(input, options) {
    return { profile: await googleProfile(input, options) };
  },
};
