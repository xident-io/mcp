import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { TARGET, pinFor, pinPath, syncOpenapi, validateSpec } from "../../../scripts/sync-openapi.mjs";

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

  // The bundled spec is a copy of the docs file the docs repository reviewed.
  // Editing it here without the sync script leaves the pin behind.
  it("the bundled spec matches its pinned SHA-256", () => {
    const pin = readFileSync(pinPath(TARGET), "utf8");
    expect(pin).toMatch(/^[0-9a-f]{64}  openapi\.json\n$/);
    expect(pinFor(readFileSync(TARGET))).toBe(pin);
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

  it("copies the source byte for byte and pins the SHA-256 of its bytes", () => {
    const from = join(dir, "public.json");
    const to = join(dir, "bundled.json");
    // Multi-byte characters and CRLF line ends, which a decode and re-encode could change.
    writeFileSync(from, spec({ "/verify/v1/init": { get: { summary: "café   ✓" } } }).replace(/\n/g, "\r\n"));
    writeFileSync(to, spec({ "/verify/v1/old": {} }));
    expect(syncOpenapi({ from, to })).toBe("written");
    expect(readFileSync(to)).toEqual(readFileSync(from));
    expect(readFileSync(pinPath(to), "utf8")).toMatch(/^[0-9a-f]{64}  openapi\.json\n$/);
    expect(readFileSync(pinPath(to), "utf8")).toBe(pinFor(readFileSync(from)));
    expect(syncOpenapi({ from, to })).toBe("unchanged");
  });

  // Decoding invalid UTF-8 replaces the bad byte with U+FFFD, so the text that
  // was checked, the bytes copied and the bytes hashed would not be one thing.
  it("refuses a source that is not valid UTF-8, or starts with a byte order mark", () => {
    const to = join(dir, "bundled.json");
    const good = spec({ "/verify/v1/init": {} });
    writeFileSync(to, good);
    const text = spec({ "/verify/v1/init": { get: { summary: "XX" } } });
    const at = text.indexOf("XX");
    const invalid = Buffer.concat([Buffer.from(text.slice(0, at)), Buffer.from([0xff]), Buffer.from(text.slice(at + 2))]);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
    for (const [bytes, message] of [[invalid, /not valid UTF-8/], [bom, /not valid JSON/]] as const) {
      const from = join(dir, "bad.json");
      writeFileSync(from, bytes);
      expect(() => syncOpenapi({ from, to })).toThrow(message);
      expect(readFileSync(to, "utf8")).toBe(good);
      expect(existsSync(pinPath(to))).toBe(false);
    }
  });

  it("in check mode reports a stale or missing pin", () => {
    const from = join(dir, "public.json");
    const to = join(dir, "bundled.json");
    writeFileSync(from, spec({ "/verify/v1/init": {} }));
    writeFileSync(to, spec({ "/verify/v1/init": {} }));
    expect(syncOpenapi({ from, to, check: true })).toBe("differs");
    writeFileSync(pinPath(to), pinFor(spec({ "/verify/v1/old": {} })));
    expect(syncOpenapi({ from, to, check: true })).toBe("differs");
    writeFileSync(pinPath(to), pinFor(spec({ "/verify/v1/init": {} })));
    expect(syncOpenapi({ from, to, check: true })).toBe("unchanged");
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
      [spec({ "/verify/v1/init": {}, "/other/v1/example": {} }), /internal paths/],
    ];
    for (const [text, message] of cases) {
      const from = join(dir, "bad.json");
      writeFileSync(from, text);
      expect(() => syncOpenapi({ from, to })).toThrow(message);
      expect(readFileSync(to, "utf8")).toBe(good);
      expect(existsSync(pinPath(to))).toBe(false);
    }
  });

  // Each of these used to pass and be copied and pinned. A null path item
  // makes allEndpoints() throw, so xident_search_docs would break; a number
  // gives no endpoints at all; a malformed security block reads as "no auth".
  it("refuses a path item, operation or security block of the wrong shape", () => {
    const to = join(dir, "bundled.json");
    const good = spec({ "/verify/v1/init": {} });
    writeFileSync(to, good);
    const withTopSecurity = (security: unknown) =>
      JSON.stringify({ swagger: "2.0", info: {}, security, paths: { "/verify/v1/init": {} } });
    const opSecurity = (security: unknown) => spec({ "/verify/v1/init": { post: { security } } });
    const cases: Array<[string, RegExp]> = [
      [spec({ "/verify/v1/init": null }), /path \/verify\/v1\/init is null, not an object of operations/],
      [spec({ "/verify/v1/init": 42 }), /path \/verify\/v1\/init is a number, not an object of operations/],
      [spec({ "/verify/v1/init": [] }), /path \/verify\/v1\/init is an array, not an object of operations/],
      [spec({ "/verify/v1/init": { post: null } }), /POST \/verify\/v1\/init is null, not an operation object/],
      [spec({ "/verify/v1/init": { get: 42 } }), /GET \/verify\/v1\/init is a number, not an operation object/],
      [spec({ "/verify/v1/init": { put: "x" } }), /PUT \/verify\/v1\/init is a string, not an operation object/],
      [spec({ "/verify/v1/init": { delete: [] } }), /DELETE \/verify\/v1\/init is an array, not an operation object/],
      [JSON.stringify({ swagger: "2.0", info: {}, paths: [{ "/verify/v1/init": {} }] }), /"paths" is an array, not an object/],
      [opSecurity([null]), /security of POST \/verify\/v1\/init is not a list of/],
      [opSecurity([42]), /security of POST \/verify\/v1\/init/],
      [opSecurity("x"), /security of POST \/verify\/v1\/init/],
      [opSecurity({}), /security of POST \/verify\/v1\/init/],
      [opSecurity(null), /security of POST \/verify\/v1\/init/],
      [opSecurity([[]]), /security of POST \/verify\/v1\/init/],
      [opSecurity([{ ApiKeyAuth: "x" }]), /security of POST \/verify\/v1\/init/],
      [opSecurity([{ ApiKeyAuth: [1] }]), /security of POST \/verify\/v1\/init/],
      [withTopSecurity([null]), /security of the spec \(top level\)/],
      [withTopSecurity({ ApiKeyAuth: [] }), /security of the spec \(top level\)/],
      [
        JSON.stringify({ swagger: "2.0", info: {}, securityDefinitions: null, paths: { "/verify/v1/init": {} } }),
        /"securityDefinitions" is null, not an object/,
      ],
      [
        JSON.stringify({ swagger: "2.0", info: {}, securityDefinitions: { ApiKeyAuth: null }, paths: { "/verify/v1/init": {} } }),
        /security definition ApiKeyAuth is null, not an object/,
      ],
    ];
    for (const [text, message] of cases) {
      const from = join(dir, "bad.json");
      writeFileSync(from, text);
      expect(() => syncOpenapi({ from, to }), text).toThrow(message);
      expect(readFileSync(to, "utf8")).toBe(good);
      expect(existsSync(pinPath(to))).toBe(false);
    }
  });

  it("accepts well-formed security blocks and a path item's shared parameters", () => {
    const text = JSON.stringify({
      swagger: "2.0", info: {}, security: [{ ApiKeyAuth: [] }],
      paths: {
        "/verify/v1/a": { parameters: [{ name: "id", in: "path" }], get: { security: [] } },
        "/verify/v1/b": { post: { security: [{ ApiKeyAuth: [], AccountToken: [] }, {}] } },
        "/oauth/c": { get: { security: [{ OAuth: ["read", "write"] }] } },
      },
    });
    expect(() => validateSpec(text, "ok.json")).not.toThrow();
  });

  it("names the missing source file", () => {
    expect(() => syncOpenapi({ from: join(dir, "missing.json"), to: join(dir, "x.json") })).toThrow(/cannot read .*missing\.json/);
  });
});

/**
 * The command itself (main()): its exit codes are what a person or a CI step
 * acts on. The script finds its target from its own place
 * (<root>/packages/shared/spec/openapi.json) and its default source two levels
 * above <root> (docs/public/openapi.json in the monorepo), so a copy of it in
 * a temporary tree runs the real code on temporary files, never on the
 * bundled spec.
 */
describe("the sync:openapi command", () => {
  let base: string;
  let target: string;
  let script: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "sync-openapi-cli-"));
    const root = join(base, "sdk", "mcp");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "packages", "shared", "spec"), { recursive: true });
    script = join(root, "scripts", "sync-openapi.mjs");
    copyFileSync(join(repoRoot, "scripts", "sync-openapi.mjs"), script);
    target = join(root, "packages", "shared", "spec", "openapi.json");
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: base, encoding: "utf8" });
  /** The target and its pin as bytes, or null when missing. */
  const snapshot = () => [target, pinPath(target)].map((f: string) => (existsSync(f) ? readFileSync(f) : null));

  it("copies with exit 0, then reports unchanged with exit 0", () => {
    const from = join(base, "public.json");
    writeFileSync(from, spec({ "/verify/v1/init": {} }));
    const first = run("--from", from);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^written: /);
    expect(readFileSync(target)).toEqual(readFileSync(from));
    expect(readFileSync(pinPath(target), "utf8")).toBe(pinFor(readFileSync(from)));
    const second = run("--from", from);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/^unchanged: /);
  });

  it("--check exits 0 when current and 1 when the copy or the pin differs, and writes nothing", () => {
    const from = join(base, "public.json");
    writeFileSync(from, spec({ "/verify/v1/init": {} }));

    // Nothing bundled yet: differs, and --check creates nothing.
    const missing = run("--check", "--from", from);
    expect(missing.status, missing.stderr).toBe(1);
    expect(missing.stderr).toMatch(/differs from/);
    expect(snapshot()).toEqual([null, null]);

    expect(run("--from", from).status).toBe(0);
    const current = run("--check", "--from", from);
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toMatch(/^unchanged: /);

    // The source moved on: differs, and the old copy and pin stay as they were.
    const before = snapshot();
    writeFileSync(from, spec({ "/verify/v1/init": {}, "/verify/v1/new": {} }));
    const changed = run("--check", "--from", from);
    expect(changed.status, changed.stderr).toBe(1);
    expect(changed.stderr).toMatch(/differs from .*--from /);
    expect(snapshot()).toEqual(before);

    // The copy is current but the pin is stale.
    writeFileSync(from, spec({ "/verify/v1/init": {} }));
    writeFileSync(pinPath(target), pinFor(spec({ "/verify/v1/old": {} })));
    const stalePin = snapshot();
    const stale = run("--check", "--from", from);
    expect(stale.status, stale.stderr).toBe(1);
    expect(snapshot()).toEqual(stalePin);
  });

  it("exits 2 on an error and writes nothing", () => {
    const bad = join(base, "bad.json");
    writeFileSync(bad, spec({ "/verify/v1/init": null }));
    const notUtf8 = join(base, "latin1.json");
    writeFileSync(notUtf8, Buffer.concat([Buffer.from('{"swagger":"2.0","x":"'), Buffer.from([0xff]), Buffer.from('","paths":{"/verify/v1/a":{}}}')]));
    const cases: Array<[string[], RegExp]> = [
      [["--from"], /--from needs a file path/],
      [["--from", join(base, "missing.json")], /cannot read .*missing\.json/],
      [["--from", bad], /not an object of operations/],
      [["--check", "--from", bad], /not an object of operations/],
      [["--from", notUtf8], /not valid UTF-8/],
    ];
    for (const [args, message] of cases) {
      const result = run(...args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toMatch(message);
      expect(snapshot(), args.join(" ")).toEqual([null, null]);
    }
  });

  // Node loads the main module by its real path. The entry check used to
  // compare that with the path as typed, so through a symlinked directory
  // main() never ran and every call, --check included, exited 0.
  it("runs, and fails when it should, when started through a symlinked directory", () => {
    const link = join(base, "link");
    symlinkSync(join(base, "sdk"), link, "dir");
    const viaLink = join(link, "mcp", "scripts", "sync-openapi.mjs");
    const result = spawnSync(process.execPath, [viaLink, "--check", "--from", join(base, "missing.json")], {
      cwd: base, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/cannot read .*missing\.json/);
  });

  it("reads docs/public/openapi.json two levels above the repository when --from is not given", () => {
    const docs = join(base, "docs", "public");
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, "openapi.json"), spec({ "/verify/v1/init": {} }));
    const written = run();
    expect(written.status, written.stderr).toBe(0);
    expect(readFileSync(target)).toEqual(readFileSync(join(docs, "openapi.json")));
    const checked = run("--check");
    expect(checked.status, checked.stderr).toBe(0);
  });
});
