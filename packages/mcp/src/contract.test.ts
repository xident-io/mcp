import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RUNTIME_TOOLS } from "./tools.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "runtime-tools.golden.json");

function contract() {
  return RUNTIME_TOOLS.map((t) => ({
    name: t.name,
    scope: t.scope,
    inputSchema: z.toJSONSchema(z.object(t.inputSchema)),
    annotations: { ...t.annotations },
  }));
}

describe("runtime tool contract freeze", () => {
  it("matches the committed golden file", () => {
    const current = contract();
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + "\n");
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as ReturnType<typeof contract>;

    const removed = golden.map((g) => g.name).filter((n) => !current.some((c) => c.name === n));
    expect(removed, `Runtime tools removed or renamed: ${removed.join(", ")}. Production agents call these by name — the contract is additive-only.`).toEqual([]);

    for (const g of golden) {
      const c = current.find((t) => t.name === g.name)!;
      expect(c.scope, `Scope changed for ${g.name}. Widening a tool's scope silently grants existing tokens more than their holder approved.`).toBe(g.scope);
      expect(c.inputSchema, `Input schema changed for ${g.name}. Only NEW OPTIONAL properties may be added.`).toMatchObject(g.inputSchema as object);
    }
  });
});
