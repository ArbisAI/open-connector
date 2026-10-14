export const triggerPermissions: readonly import("../../triggers/metadata.ts").TriggerPermission[] = [
  {
    id: "telnyx.on_message_received",
    name: "Inbound Message Received",
    description:
      "Receives inbound SMS and MMS messages for a messaging profile and manages that profile's webhook URL.",
    providerPermissions: [],
    instructions:
      "Requires the Telnyx API key. Linking the Trigger sets the selected messaging profile's webhook URL, so use a dedicated profile when another webhook is already configured.",
  },
];
