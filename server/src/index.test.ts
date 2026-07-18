import { describe, expect, it } from "vitest";
import {
  agrentingAppGalleryEntry,
  createServerAdapter,
  type,
} from "./index.js";

describe("server entrypoint", () => {
  it("exports the external adapter factory expected at package root", () => {
    const adapter = createServerAdapter();

    expect(type).toBe("agrenting");
    expect(adapter.type).toBe("agrenting");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.testEnvironment).toBe("function");
    expect(typeof adapter.getConfigSchema).toBe("function");
  });

  it("exports the Apps v2 gallery descriptor", () => {
    expect(agrentingAppGalleryEntry.transportTemplate).toEqual({
      transport: "remote_http",
      url: "https://agrenting.com/mcp/hirer",
    });
  });
});
