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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET = resolve(ROOT, "packages/shared/spec/openapi.json");
export const DEFAULT_SOURCE = resolve(ROOT, "../../docs/public/openapi.json");

/** The pin file next to a bundled spec, and its content for a spec text. */
export const pinPath = (to) => `${to}.sha256`;
export const pinFor = (text) => `${createHash("sha256").update(text).digest("hex")}  openapi.json\n`;

/**
 * Refuse a source that is not a public Swagger 2.0 spec with paths, so a
 * wrong or empty file is never copied over a good one.
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
  const paths = Object.keys(spec.paths ?? {});
  if (paths.length === 0) {
    throw new Error(`${source} has no paths`);
  }
  const internal = paths.filter((p) => !/^\/(verify|public|oauth|\.well-known)\//.test(p));
  if (internal.length > 0) {
    throw new Error(`${source} has internal paths (${internal.slice(0, 3).join(", ")}); use the public filter's output`);
  }
}

/**
 * Compare or copy. Returns "unchanged", "written" or "differs" (check mode
 * only). Throws when the source cannot be read or is not a public spec.
 */
export function syncOpenapi({ from = DEFAULT_SOURCE, to = TARGET, check = false } = {}) {
  let text;
  try {
    text = readFileSync(from, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${from}: ${err.message}`);
  }
  validateSpec(text, from);

  const read = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const pin = pinFor(text);
  if (read(to) === text && read(pinPath(to)) === pin) return "unchanged";
  if (check) return "differs";
  writeFileSync(to, text);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
