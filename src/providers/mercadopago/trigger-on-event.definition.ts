import type { TriggerKeySnapshot } from "../../triggers/common/types.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";

export const snapshot: TriggerKeySnapshot & { readonly type: "integration" } = {
  configInputs: [
    {
      handle: "topics",
      jsonSchema: s.array(
        s.stringEnum([
          "payment",
          "merchant_order",
          "subscription_preapproval",
          "subscription_authorized_payment",
          "chargebacks",
        ]),
        { minItems: 1, uniqueItems: true },
      ),
      nullable: false,
    },
  ],
  definitionVersion: 1,
  description: "Triggers when selected Mercado Pago notifications arrive. The body is a notice, not the payment.",
  displayName: "Account notification",
  endpoint: {
    body: { allowArray: false, allowEmpty: false, formats: ["json"] },
    methods: ["POST"],
    successStatus: 200,
  },
  key: "mercadopago.on_event",
  name: "on_event",
  outputs: [
    { handle: "topic", jsonSchema: s.string(), nullable: false },
    { handle: "action", jsonSchema: s.string(), nullable: false },
    { handle: "notificationId", jsonSchema: s.string(), nullable: false },
    { handle: "resourceId", jsonSchema: s.string(), nullable: false },
    { handle: "liveMode", jsonSchema: s.boolean(), nullable: false },
  ],
  provider: "mercadopago",
  type: "integration",
};
