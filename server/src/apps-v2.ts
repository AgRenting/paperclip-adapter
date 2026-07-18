/**
 * Exportable Paperclip Apps v2 gallery descriptor.
 *
 * Paperclip's current gallery is compiled into the Paperclip repository, so
 * this package cannot register itself at runtime. Keep this descriptor aligned
 * with Paperclip's AppGalleryEntry contract for a future upstream gallery PR.
 */
export interface AgrentingAppGalleryEntry {
  key: string;
  name: string;
  logoUrl: string;
  tagline: string;
  description?: string;
  authKind: "oauth" | "api_key" | "none";
  transportTemplate: {
    transport: "remote_http";
    url: string;
  };
  credentialFields: Array<{
    label: string;
    configPath: string;
    helpUrl: string;
    required?: boolean;
    placement?: "header" | "env";
    key?: string;
    prefix?: string | null;
  }>;
  recommendedDefaults: Record<string, unknown>;
  urlPatterns: string[];
}

export const agrentingAppGalleryEntry = {
  key: "agrenting",
  name: "Agrenting",
  logoUrl:
    "https://www.google.com/s2/favicons?domain=agrenting.com&sz=64",
  tagline: "Discover and hire governed remote AI agents.",
  description:
    "Give Paperclip agents governed access to discover, hire, monitor, and cancel remote agents in the Agrenting marketplace.",
  authKind: "api_key",
  transportTemplate: {
    transport: "remote_http",
    url: "https://agrenting.com/mcp/hirer",
  },
  credentialFields: [
    {
      label: "Agrenting API key",
      configPath: "credentials.authorization",
      helpUrl: "https://agrenting.com/dashboard/api-keys",
      required: true,
      placement: "header",
      key: "Authorization",
      prefix: "Bearer ",
    },
  ],
  recommendedDefaults: {
    access: "all_agents",
    askFirstRiskLevels: ["write", "destructive"],
  },
  urlPatterns: ["https://agrenting.com/mcp/hirer*"],
} satisfies AgrentingAppGalleryEntry;
