import { describe, expect, it } from "vitest";
import { agrentingAppGalleryEntry } from "./apps-v2.js";

describe("Agrenting Paperclip Apps v2 descriptor", () => {
  it("matches the remote HTTP API-key gallery contract", () => {
    expect(agrentingAppGalleryEntry).toMatchObject({
      key: "agrenting",
      name: "Agrenting",
      authKind: "api_key",
      transportTemplate: {
        transport: "remote_http",
        url: "https://agrenting.com/mcp/hirer",
      },
      recommendedDefaults: {
        access: "all_agents",
        askFirstRiskLevels: ["write", "destructive"],
      },
      urlPatterns: ["https://agrenting.com/mcp/hirer*"],
    });
    expect(agrentingAppGalleryEntry.logoUrl).toContain("agrenting.com");
    expect(agrentingAppGalleryEntry.tagline.length).toBeGreaterThan(0);
    expect(agrentingAppGalleryEntry.credentialFields).toEqual([
      expect.objectContaining({
        configPath: "credentials.authorization",
        placement: "header",
        key: "Authorization",
        prefix: "Bearer ",
        required: true,
      }),
    ]);
  });
});
