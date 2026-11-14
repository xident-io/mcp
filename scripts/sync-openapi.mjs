#!/usr/bin/env node
/**
 * Copy the public API spec into packages/shared/spec/openapi.json, or check
 * that the copy is current.
 *
 * The spec is made in the projects (monorepo) repository: swag reads the api's
 * annotations (`make api-docs`), then scripts/openapi-public.py keeps the
 * public part and writes docs/public/openapi.json. This script copies that
 * file here byte for byte. It does not generate anything itself.
 *
 * It also writes packages/shared/spec/openapi.json.sha256, the SHA-256 of the
 * copied file (`shasum -a 256` format). The docs repository checks every
 * text in docs/public/openapi.json before it is merged there; the pin lets a
 * reviewer of this repository compare the bundled file with that reviewed
 * docs file by one hash, and the tests fail when the bundled spec is edited
 * here by hand without the pin.
 *
 * Usage:
 *   pnpm sync:openapi                       copy from the default source
 *   pnpm sync:openapi --check               exit 1 when the copy differs
 *   pnpm sync:openapi --from <file>         use another source file
 *
 * The default source assumes this repository is checked out at sdk/mcp inside
 * the monorepo, next to docs/ (../../docs/public/openapi.json).
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = resolve(ROOT, "packages/shared/spec/openapi.json");
export const DEFAULT_SOURCE = resolve(ROOT, "../../docs/public/openapi.json");

/** The pin file next to a bundled spec, and its content for the spec's bytes. */
export const pinPath = (to) => `${to}.sha256`;
export const pinFor = (bytes) => `${createHash("sha256").update(bytes).digest("hex")}  openapi.json\n`;

/** The operation keys of a Swagger 2.0 path item, as packages/shared/src/openapi.ts reads them. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** "null", "an array", "a number", ... for an error message. */
const kindOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return `${/^[aeiou]/.test(type) ? "an" : "a"} ${type}`;
};

/**
 * Swagger 2.0 security: a list of requirement objects, each mapping a scheme
 * name to a list of scope names. `[]` (no auth) and `{}` (an alternative that
 * needs no credential) are allowed. Anything else, such as `[null]`, would be
 * read by the MCP servers as no auth, so it is refused here.
 */
function checkSecurity(security, where, source) {
  const ok =
    Array.isArray(security) &&
    security.every(
      (requirement) =>
        isObject(requirement) &&
        Object.values(requirement).every(
          (scopes) => Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string"),
        ),
    );
  if (!ok) {
    throw new Error(`${source}: the security of ${where} is not a list of {"<scheme>": ["<scope>", ...]} objects`);
  }
}

/**
 * Refuse a source that is not a public Swagger 2.0 spec with paths, or whose
 * path items, operations or security blocks have the wrong shape, so a wrong,
 * empty or broken file is never copied over a good one. A null path item, for
 * one, would make the MCP servers' endpoint list throw.
 */
export function validateSpec(text, source) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (spec === null || typeof spec !== "object" || spec.swagger !== "2.0") {
    throw new Error(`${source} is not a Swagger 2.0 spec`);
  }
  if (spec.paths !== undefined && !isObject(spec.paths)) {
    throw new Error(`${source}: "paths" is ${kindOf(spec.paths)}, not an object`);
  }
  const paths = Object.keys(spec.paths ?? {});
  if (paths.length === 0) {
    throw new Error(`${source} has no paths`);
  }
  const internal = paths.filter((p) => !/^\/(verify|public|oauth|\.well-known)\//.test(p));
  if (internal.length > 0) {
    throw new Error(`${source} has internal paths (${internal.slice(0, 3).join(", ")}); use the public filter's output`);
  }
  if (spec.security !== undefined) checkSecurity(spec.security, "the spec (top level)", source);
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!isObject(item)) {
      throw new Error(`${source}: path ${path} is ${kindOf(item)}, not an object of operations`);
    }
    for (const method of HTTP_METHODS) {
      if (!Object.hasOwn(item, method)) continue;
      const op = item[method];
      const where = `${method.toUpperCase()} ${path}`;
      if (!isObject(op)) {
        throw new Error(`${source}: ${where} is ${kindOf(op)}, not an operation object`);
      }
      if (op.security !== undefined) checkSecurity(op.security, where, source);
    }
  }
}

/**
 * The source's bytes as text, refusing invalid UTF-8. A lenient decode would
 * turn a bad byte into U+FFFD, so the text checked here and the bytes copied
 * and hashed would differ. The byte order mark is kept, not stripped, so a
 * file that starts with one fails JSON.parse here, as it would when the MCP
 * servers load the bundled spec.
 */
function decodeUtf8(bytes, source) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${source} is not valid UTF-8`);
  }
}

/**
 * Compare or copy. Returns "unchanged", "written" or "differs" (check mode
 * only). Throws when the source cannot be read or is not a public spec. The
 * source's bytes are copied and hashed as they are, never a decoded and
 * re-encoded string.
 */
export function syncOpenapi({ from = DEFAULT_SOURCE, to = TARGET, check = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(from);
  } catch (err) {
    throw new Error(`cannot read ${from}: ${err.message}`);
  }
  validateSpec(decodeUtf8(bytes, from), from);

  const read = (file) => {
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  };
  const pin = pinFor(bytes);
  const current = read(to);
  const currentPin = read(pinPath(to));
  if (current !== null && current.equals(bytes) && currentPin !== null && currentPin.equals(Buffer.from(pin))) {
    return "unchanged";
  }
  if (check) return "differs";
  writeFileSync(to, bytes);
  writeFileSync(pinPath(to), pin);
  return "written";
}

function main(argv) {
  const check = argv.includes("--check");
  const fromIndex = argv.indexOf("--from");
  const from = fromIndex >= 0 ? argv[fromIndex + 1] : DEFAULT_SOURCE;
  if (fromIndex >= 0 && !from) {
    console.error("--from needs a file path");
    return 2;
  }
  try {
    const result = syncOpenapi({ from: resolve(from), check });
    if (result === "differs") {
      console.error(`${TARGET} differs from ${from}. Run: pnpm sync:openapi${fromIndex >= 0 ? ` --from ${from}` : ""}`);
      return 1;
    }
    console.log(`${result}: ${TARGET}`);
    return 0;
  } catch (err) {
    console.error(`sync:openapi: ${err.message}`);
    return 2;
  }
}

/**
 * True when node was started on this file. Node loads the main module by its
 * real path, so both sides are compared as real paths: through a symlinked
 * directory (macOS's /var is one) a plain comparison is false, main() never
 * runs, and `--check` exits 0 without checking anything.
 */
function isMain() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

if (isMain()) {
  process.exit(main(process.argv.slice(2)));
}
