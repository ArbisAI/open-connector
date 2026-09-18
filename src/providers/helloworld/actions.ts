import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "helloworld";

export const helloworldActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "say_hello",
    description: "Return a greeting message, optionally addressed to a given name.",
    inputSchema: s.object(
      {
        name: s.string({ description: "The name to greet. Defaults to a generic greeting when omitted." }),
      },
      { description: "Say hello input." },
    ),
    outputSchema: s.object(
      {
        message: s.string({ description: "The greeting message." }),
      },
      { required: ["message"], description: "Say hello result." },
    ),
  }),
];
