export const triggerPermissions: readonly import("../../triggers/metadata.ts").TriggerPermission[] = [
  {
    id: "mercadopago.on_event",
    name: "Account notification",
    description: "Receives selected Mercado Pago webhook notifications and checks their signature.",
    providerPermissions: [],
    instructions:
      "Set the webhook secret from Your integrations > Webhooks. Point Mercado Pago at the trigger URL and select the topics you subscribe to here.",
  },
];
