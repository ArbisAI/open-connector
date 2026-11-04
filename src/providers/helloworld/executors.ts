import type { ProviderExecutors } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";

import { optionalString } from "../../core/cast.ts";
import { defineProviderExecutors } from "../provider-runtime.ts";

const service = "helloworld";

/**
 * Hello World action handlers. Purely local computation; no network calls.
 */
export const helloworldActionHandlers: ProviderActionHandlers<
  "helloworld",
  (input: Record<string, unknown>) => Promise<unknown>
> = {
  async say_hello(input): Promise<unknown> {
    const name = optionalString(input.name);
    return { message: name ? `Hello, ${name}!` : "Hello, World!" };
  },
};

export const executors: ProviderExecutors = defineProviderExecutors({
  service,
  handlers: helloworldActionHandlers,
  createContext(): Record<string, never> {
    return {};
  },
});
