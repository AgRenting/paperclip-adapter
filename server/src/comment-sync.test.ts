import { describe, it, expect } from "vitest";
import { formatAgentResponse } from "./comment-sync.js";

describe("formatAgentResponse", () => {
  it("formats agent name and message as bold markdown", () => {
    const result = formatAgentResponse("CodeReviewer", "Your code looks great!");
    expect(result).toBe("**CodeReviewer says:**\n\nYour code looks great!");
  });

  it("handles empty message", () => {
    const result = formatAgentResponse("Bot", "");
    expect(result).toBe("**Bot says:**\n\n");
  });

  it("preserves markdown in message", () => {
    const result = formatAgentResponse("Agent", "Here is a `code` block and **bold** text.");
    expect(result).toContain("`code`");
    expect(result).toContain("**bold**");
  });

  it("handles multi-line messages", () => {
    const result = formatAgentResponse("Agent", "Line 1\nLine 2\nLine 3");
    expect(result).toContain("Line 1\nLine 2\nLine 3");
  });
});
