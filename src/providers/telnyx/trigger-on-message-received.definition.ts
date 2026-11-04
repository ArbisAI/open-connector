import type { TriggerKeySnapshot } from "../../triggers/common/types.ts";

import { jsonSchema as s } from "../../core/json-schema.ts";

const mediaItemSchema = s.requiredObject("One inbound MMS attachment.", {
  url: s.string({ format: "uri", description: "The Telnyx download URL, which expires after 30 days." }),
  contentType: s.string({ description: "The MIME type of the attachment." }),
  size: s.nullableInteger("The attachment size in bytes when Telnyx reports it."),
});

export const snapshot: TriggerKeySnapshot & { readonly type: "integration" } = {
  configInputs: [
    {
      handle: "messagingProfileId",
      jsonSchema: s.nonEmptyString("The Telnyx messaging profile ID whose inbound messages are received."),
      nullable: false,
    },
    {
      handle: "publicKey",
      jsonSchema: s.nonEmptyString(
        "The Telnyx account public key that verifies webhook signatures, from Mission Control under Keys & Credentials.",
      ),
      nullable: false,
    },
  ],
  definitionVersion: 2,
  description:
    "Triggers when the Telnyx messaging profile receives an inbound SMS or MMS message, or reports an outbound delivery status.",
  displayName: "Inbound Message Received",
  endpoint: {
    body: { allowArray: false, allowEmpty: false, formats: ["json"] },
    methods: ["POST"],
    successStatus: 202,
  },
  key: "telnyx.on_message_received",
  name: "on_message_received",
  outputs: [
    {
      handle: "kind",
      jsonSchema: s.stringEnum("The event kind.", ["message", "delivery"]),
      nullable: false,
      description: "`message` for an inbound message, `delivery` for an outbound delivery status update.",
    },
    { handle: "messageId", jsonSchema: s.string(), nullable: false, description: "The Telnyx message ID." },
    {
      handle: "from",
      jsonSchema: s.string(),
      nullable: false,
      description: "The sender phone number in E.164 format.",
    },
    {
      handle: "to",
      jsonSchema: s.string(),
      nullable: false,
      description: "The Telnyx phone number that received the message, in E.164 format.",
    },
    {
      handle: "text",
      jsonSchema: s.string(),
      nullable: true,
      description: "The message body; null for media-only MMS messages.",
    },
    { handle: "media", jsonSchema: s.array("The inbound MMS attachments.", mediaItemSchema), nullable: false },
    {
      handle: "receivedAt",
      jsonSchema: s.string(),
      nullable: true,
      description: "The ISO 8601 timestamp when Telnyx received the message.",
    },
    {
      handle: "status",
      jsonSchema: s.string(),
      nullable: true,
      description:
        "For delivery events: queued, sending, sent, delivered, sending_failed, delivery_failed, or delivery_unconfirmed.",
    },
    {
      handle: "errorCode",
      jsonSchema: s.string(),
      nullable: true,
      description: "For failed delivery events: the Telnyx error code, such as 40300.",
    },
    {
      handle: "errorTitle",
      jsonSchema: s.string(),
      nullable: true,
      description: "For failed delivery events: the Telnyx error title.",
    },
    {
      handle: "errorDetail",
      jsonSchema: s.string(),
      nullable: true,
      description: "For failed delivery events: the Telnyx error detail.",
    },
    {
      handle: "encoding",
      jsonSchema: s.string(),
      nullable: true,
      description: "For delivery events: the encoding Telnyx used, such as GSM-7 or UCS-2.",
    },
    {
      handle: "parts",
      jsonSchema: s.nullableInteger("For delivery events: the number of SMS parts Telnyx billed."),
      nullable: true,
      description: "For delivery events: the number of SMS parts Telnyx billed.",
    },
    {
      handle: "costAmount",
      jsonSchema: s.string(),
      nullable: true,
      description: "For delivery events: the message cost amount reported by Telnyx.",
    },
    {
      handle: "costCurrency",
      jsonSchema: s.string(),
      nullable: true,
      description: "For delivery events: the currency of the reported cost.",
    },
  ],
  provider: "telnyx",
  type: "integration",
};
