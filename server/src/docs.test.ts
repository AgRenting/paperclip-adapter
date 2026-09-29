import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentConfigurationDoc } from "./paperclip.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");
const readme = read("README.md");
const changelog = read("CHANGELOG.md");
const version = (JSON.parse(read("package.json")) as { version: string }).version;

/** The changelog section that starts at the given heading, up to the next heading. */
function section(heading: string): string {
  const start = changelog.indexOf(`\n## ${heading}`);
  expect(start, `CHANGELOG heading ${heading}`).toBeGreaterThanOrEqual(0);
  const next = changelog.indexOf("\n## ", start + 1);
  return changelog.slice(start, next === -1 ? undefined : next);
}

describe("release files", () => {
  it("keeps package.json, VERSION and the newest changelog heading on one version", () => {
    expect(read("VERSION").trim()).toBe(version);
    expect(changelog.match(/^## (\S+)/m)?.[1]).toBe(version);
  });

  it("dates every changelog heading, so a published release never reads as unreleased", () => {
    const headings = changelog.match(/^## .*$/gm) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading).toMatch(/^## \d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)$/);
    }
    expect(readme).not.toMatch(/unreleased|candidate/i);
  });

  it("calls out the 0.5.1 change of the default team wake reasons", () => {
    const entry = section(`${version} `);
    expect(entry).toContain("swarmCreateWakeReasons");
    expect(entry).toContain("issue_assigned");
    expect(entry).toContain("issue_commented");
    expect(entry).toMatch(/no longer|does not|opt in/i);
  });

  it("states the retry rule of team refusals, not that every 4xx is final", () => {
    expect(changelog).not.toContain("Treat 4xx team refusals as final");
    expect(section("0.5.0 ")).toContain("other than 408, 425 and 429");
  });
});

describe("README", () => {
  it("does not describe team hiring as a rollout that is still under way", () => {
    expect(readme).not.toMatch(/rolled out|rollout/i);
    expect(readme).toMatch(/Agrenting answers\s+`403 SWARMS_DISABLED`\s+when\s+team\s+hiring\s+is\s+switched\s+off\s+for\s+your\s+account\./);
  });

  it("documents the team wake default and how to opt in to comments", () => {
    expect(readme).toContain("| `swarmCreateWakeReasons` | No | `issue_assigned` |");
    expect(readme).not.toContain("issue_assigned,issue_commented");
    expect(readme).not.toMatch(/remove `issue_commented`/);
    expect(readme).toMatch(/add `issue_commented`/i);
  });

  it("lists agentDid as needed in hiring mode only and mentions teams up front", () => {
    expect(readme).not.toMatch(/\| `agentDid` \| Yes \|/);
    expect(readme).toMatch(/\| `agentDid` \| Hiring mode \|/);
    expect(readme).toContain("one configured Agrenting agent or team");
    expect(agentConfigurationDoc).toContain("remote agent or team hired from Agrenting");
  });

  it("marks the ./ui helper deprecated and names the replacement", () => {
    const legacy = readme.slice(readme.indexOf("## Legacy helper surface"));
    expect(legacy).toMatch(/`\.\/ui`[^]*deprecated/i);
    expect(legacy).toContain("getConfigSchema");
  });
});

describe("legacy ./ui helper", () => {
  it("is tagged @deprecated on the function the subpath exports", () => {
    const source = read("ui/src/adapter.ts");
    const doc = source.slice(0, source.indexOf("export function parseConfigSchema"));
    expect(doc.slice(doc.lastIndexOf("/**"))).toMatch(/@deprecated[^]*getConfigSchema/);
  });
});
