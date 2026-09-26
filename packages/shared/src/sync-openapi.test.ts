import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { TARGET, syncOpenapi, validateSpec } from "../../../scripts/sync-openapi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const spec = (paths: Record<string, unknown>) => JSON.stringify({ swagger: "2.0", info: {}, paths }, null, 2) + "\n";

describe("the sync:openapi script entry", () => {
  it("points at a file that exists", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const command = pkg.scripts["sync:openapi"];
    expect(command).toBe("node scripts/sync-openapi.mjs");
    expect(existsSync(join(repoRoot, "scripts/sync-openapi.mjs"))).toBe(true);
  });

  it("writes to the bundled spec, which is itself a valid public spec", () => {
    expect(TARGET).toBe(join(repoRoot, "packages/shared/spec/openapi.json"));
    expect(() => validateSpec(readFileSync(TARGET, "utf8"), TARGET)).not.toThrow();
  });
});

describe("syncOpenapi", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-openapi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the source byte for byte", () => {
    const from = join(dir, "public.json");
    const to = join(dir, "bundled.json");
    writeFileSync(from, spec({ "/verify/v1/init": {} }));
    writeFileSync(to, spec({ "/verify/v1/old": {} }));
    expect(syncOpenapi({ from, to })).toBe("written");
    expect(readFileSync(to, "utf8")).toBe(readFileSync(from, "utf8"));
    expect(syncOpenapi({ from, to })).toBe("unchanged");
  });

  it("in check mode reports a difference and writes nothing", () => {
    const from = join(dir, "public.json");
    const to = join(dir, "bundled.json");
    writeFileSync(from, spec({ "/verify/v1/init": {} }));
    const old = spec({ "/verify/v1/old": {} });
    writeFileSync(to, old);
    expect(syncOpenapi({ from, to, check: true })).toBe("differs");
    expect(readFileSync(to, "utf8")).toBe(old);
  });

  it("refuses a source that is not a public Swagger 2.0 spec with paths", () => {
    const to = join(dir, "bundled.json");
    const good = spec({ "/verify/v1/init": {} });
    writeFileSync(to, good);
    const cases: Array<[string, RegExp]> = [
      ["{not json", /not valid JSON/],
      [JSON.stringify({ openapi: "3.0.0", paths: { "/verify/v1/init": {} } }), /not a Swagger 2.0 spec/],
      [spec({}), /has no paths/],
      [spec({ "/verify/v1/init": {}, "/admin/v1/tenants": {} }), /internal paths/],
    ];
    for (const [text, message] of cases) {
      const from = join(dir, "bad.json");
      writeFileSync(from, text);
      expect(() => syncOpenapi({ from, to })).toThrow(message);
      expect(readFileSync(to, "utf8")).toBe(good);
    }
  });

  it("names the missing source file", () => {
    expect(() => syncOpenapi({ from: join(dir, "missing.json"), to: join(dir, "x.json") })).toThrow(/cannot read .*missing\.json/);
  });
});
