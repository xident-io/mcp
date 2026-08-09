import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolContract } from "./contract.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "tools.golden.json");

describe("tool contract freeze", () => {
  it("matches the committed golden file", () => {
    const current = toolContract();

    // UPDATE_GOLDEN=1 regenerates. Use it ONLY for an additive change you have
    // consciously decided is additive — a diff that renames or removes anything
    // is a broken customer promise, not a stale snapshot.
    if (process.env["UPDATE_GOLDEN"] === "1") {
      writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + "\n");
    }

    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as ReturnType<typeof toolContract>;

    const currentNames = current.map((t) => t.name);
    const goldenNames = golden.map((t) => t.name);
    const removed = goldenNames.filter((n) => !currentNames.includes(n));
    expect(removed, `Tools removed or renamed: ${removed.join(", ")}. The tool contract is additive-only — add a new name, never change an existing one.`).toEqual([]);

    for (const g of golden) {
      const c = current.find((t) => t.name === g.name)!;
      expect(c.inputSchema, `Input schema changed for ${g.name}. Only NEW OPTIONAL properties may be added.`)
        .toMatchObject(g.inputSchema as object);
    }
  });

  it("declares required inputs that clients must send", () => {
    const search = toolContract().find((t) => t.name === "xident_search_docs")!;
    expect((search.inputSchema as { required?: string[] }).required).toContain("query");
  });

  it("marks read-only tools as read-only in the published contract", () => {
    for (const t of toolContract()) {
      if (t.name === "xident_search_docs" || t.name === "xident_get_endpoint") {
        expect(t.annotations["readOnlyHint"]).toBe(true);
      }
    }
  });
});
