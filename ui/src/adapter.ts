/**
 * UI adapter for the Agrenting Paperclip adapter.
 *
 * The UI adapter provides:
 * - Label and metadata for display in adapter dropdowns
 * - Config field definitions for the agent configuration form
 * - A buildAdapterConfig helper that maps form values to adapter config
 */

export interface UIConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "select" | "number";
  description: string;
  required?: boolean;
  defaultValue?: string | number;
  options?: { label: string; value: string }[];
  placeholder?: string;
  sensitive?: boolean;
}

export interface UIAdapterInfo {
  label: string;
  description: string;
  icon: string;
  configFields: UIConfigField[];
  buildAdapterConfig: (values: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Parse the adapter config schema into UI-renderable config fields.
 * This is called by the Paperclip UI to generate the configuration form.
 */
export function parseConfigSchema(): UIAdapterInfo {
  return {
    label: "Agrenting",
    description:
      "Remote AI agent via the Agrenting platform. Submit tasks to agents on agrenting.com using the CACP protocol.",
    icon: "agrenting",
    configFields: [
      {
        key: "agrentingUrl",
        label: "Agrenting URL",
        type: "url",
        description: "Base URL of the Agrenting platform",
        required: true,
        defaultValue: "https://www.agrenting.com",
        placeholder: "https://www.agrenting.com",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        description: "Your Agrenting API key for authentication",
        required: true,
        sensitive: true,
        placeholder: "ak_...",
      },
      {
        key: "agentDid",
        label: "Agent DID",
        type: "text",
        description:
          "Decentralized identifier of the target agent (did:agrenting:...)",
        required: true,
        placeholder: "did:agrenting:your-agent-id",
      },
      {
        key: "webhookSecret",
        label: "Webhook Secret",
        type: "password",
        description:
          "Signing secret for verifying task completion webhooks from Agrenting",
        sensitive: true,
        placeholder: "whsec_...",
      },
      {
        key: "webhookCallbackUrl",
        label: "Webhook Callback URL",
        type: "url",
        description:
          "Public URL where Agrenting should POST task events. Leave empty to use the built-in listener.",
        placeholder: "https://your-host:8765/webhook",
      },
      {
        key: "pricingModel",
        label: "Pricing Model",
        type: "select",
        description: "How this agent is billed",
        defaultValue: "fixed",
        options: [
          { label: "Fixed price per task", value: "fixed" },
          { label: "Per-token usage", value: "per-token" },
          { label: "Subscription", value: "subscription" },
        ],
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        description: "Maximum time to wait for task completion",
        defaultValue: 600,
      },
      {
        key: "instructionsBundleMode",
        label: "Instructions Mode",
        type: "select",
        description:
          "How task instructions are delivered to the remote agent",
        defaultValue: "inline",
        options: [
          { label: "Inline (included in task payload)", value: "inline" },
          {
            label: "Managed (uploaded to Agrenting documents API)",
            value: "managed",
          },
        ],
      },
    ],
    buildAdapterConfig: (values: Record<string, unknown>) => ({
      agrentingUrl: values.agrentingUrl ?? "https://www.agrenting.com",
      apiKey: values.apiKey,
      agentDid: values.agentDid,
      webhookSecret: values.webhookSecret,
      webhookCallbackUrl: values.webhookCallbackUrl || undefined,
      pricingModel: values.pricingModel ?? "fixed",
      timeoutSec: Number(values.timeoutSec) || 600,
      instructionsBundleMode: values.instructionsBundleMode ?? "inline",
    }),
  };
}
