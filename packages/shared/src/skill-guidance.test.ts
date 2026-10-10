import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The plugin skill is what an agent reads before it writes an integration, so
 * a wrong access rule there is copied into tenants' backends. Astra round 2
 * found it teaching "Gate access on verified". These checks keep the rule the
 * same as provesAge in result.ts and in every SDK.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const skillDir = join(root, "plugin", "skills", "xident-verification");
const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const webhooks = readFileSync(join(skillDir, "references", "webhooks.md"), "utf8");
const integration = readFileSync(join(skillDir, "references", "integration.md"), "utf8");

describe("plugin skill access rule", () => {
  it("no longer grants on verified alone", () => {
    expect(skill).not.toMatch(/Gate access on \*\*`verified`\*\*/);
  });

  it("teaches ownership, the age gate, ID results and test verdicts", () => {
    for (const phrase of ["external_user_id", "checks.age.gate", "id_verification", "`test` is not `true`"]) {
      expect(skill, phrase).toContain(phrase);
    }
  });

  it("names the three successes whose checks.age.passed is false, and never requires it in code", () => {
    for (const phrase of ["xident_id", "eu_wallet", "Test mode"]) expect(skill, phrase).toContain(phrase);
    expect(skill).not.toMatch(/age\??\.passed\s*===\s*true/);
  });

  it("repeats the rule where results and webhooks are described", () => {
    for (const text of [webhooks, integration]) {
      expect(text).toContain("external_user_id");
      expect(text).toContain("checks.age.gate");
    }
  });
});
