import type { ProviderDefinition } from "../../core/types.ts";

import { helloworldActions } from "./actions.ts";

const service = "helloworld";

/**
 * Hello World test provider used to verify the local action execution pipeline. It requires no credentials and calls no external API.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Hello World",
  categories: ["Developer Tools"],
  authTypes: ["no_auth"],
  auth: [{ type: "no_auth" }],
  actions: helloworldActions,
};
