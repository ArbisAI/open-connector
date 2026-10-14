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
  definitionVersion: 1,
  description: "Triggers when the Telnyx messaging profile receives an inbound SMS or MMS message.",
  displayName: "Inbound Message Received",
  endpoint: {
    body: { allowArray: false, allowEmpty: false, formats: ["json"] },
    methods: ["POST"],
    successStatus: 202,
  },
  key: "telnyx.on_message_received",
  name: "on_message_received",
  outputs: [
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
  ],
  provider: "telnyx",
  type: "integration",
};
