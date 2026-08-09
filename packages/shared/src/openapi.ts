import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bundled spec is Swagger 2.0 (not OpenAPI 3): body parameters live in
 * `parameters[in=body].schema`, and shared models live under `definitions`.
 * Generated from the Go routes by scripts/openapi-public.py, so it cannot drift
 * from what the API actually serves the way hand-written docs can.
 */
export interface SwaggerSpec {
  swagger: string;
  info: { title?: string; version?: string };
  host?: string;
  basePath?: string;
  paths: Record<string, Record<string, RawOperation>>;
  definitions?: Record<string, unknown>;
}

interface RawOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  security?: unknown[];
}

export interface EndpointDoc {
  path: string;
  method: string;
  summary: string;
  description: string;
  tags: string[];
  /** Auth required, derived from the operation's security block. */
  auth: "api_key" | "none" | "unknown";
  parameters: unknown[];
  responses: Record<string, unknown>;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

let cached: SwaggerSpec | null = null;

/** Load the bundled spec. Cached — the file never changes at runtime. */
export function loadSpec(): SwaggerSpec {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/openapi.js -> ../spec, src/openapi.ts -> ../spec
  const specPath = join(here, "..", "spec", "openapi.json");
  cached = JSON.parse(readFileSync(specPath, "utf8")) as SwaggerSpec;
  return cached;
}

/** Reset the cache. Tests only. */
export function __resetSpecCache(): void {
  cached = null;
}

const MAX_REF_DEPTH = 6;

/**
 * Replace `$ref` pointers with the definitions they name, so a caller gets a
 * usable schema instead of a pointer it would have to chase. Depth-limited and
 * cycle-aware: Xident's models are self-referential in places, and an
 * unbounded resolver would hang the server rather than fail a request.
 */
export function resolveRefs(
  node: unknown,
  spec: SwaggerSpec,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (depth > MAX_REF_DEPTH || node === null || typeof node !== "object") return node;

  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, spec, depth + 1, seen));
  }

  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    const name = ref.replace("#/definitions/", "");
    if (seen.has(name)) return { $circular: name };
    const target = spec.definitions?.[name];
    if (target === undefined) return { $unresolved: ref };
    return resolveRefs(target, spec, depth + 1, new Set([...seen, name]));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = resolveRefs(value, spec, depth + 1, seen);
  }
  return out;
}

function authOf(op: RawOperation): EndpointDoc["auth"] {
  if (!op.security) return "unknown";
  if (op.security.length === 0) return "none";
  const names = op.security.flatMap((s) => Object.keys(s as object));
  return names.includes("ApiKeyAuth") ? "api_key" : "unknown";
}

function toDoc(path: string, method: string, op: RawOperation, spec: SwaggerSpec): EndpointDoc {
  return {
    path,
    method: method.toUpperCase(),
    summary: op.summary ?? "",
    description: op.description ?? "",
    tags: op.tags ?? [],
    auth: authOf(op),
    parameters: (resolveRefs(op.parameters ?? [], spec) as unknown[]),
    responses: (resolveRefs(op.responses ?? {}, spec) as Record<string, unknown>),
  };
}

/** Exact lookup. Returns null for an unknown path or method — never throws. */
export function findEndpoint(path: string, method: string, spec = loadSpec()): EndpointDoc | null {
  const ops = spec.paths[path];
  if (!ops) return null;
  const key = method.toLowerCase();
  const op = ops[key];
  if (!op) return null;
  return toDoc(path, key, op, spec);
}

/** Every operation in the spec, flattened. */
export function allEndpoints(spec = loadSpec()): EndpointDoc[] {
  const out: EndpointDoc[] = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!HTTP_METHODS.has(method)) continue;
      out.push(toDoc(path, method, op, spec));
    }
  }
  return out;
}

/**
 * Rank endpoints against a free-text query. Path matches outrank summary
 * matches, which outrank description matches — an agent asking for "init"
 * wants /verify/v1/init first, not every endpoint whose prose says "initialize".
 */
export function searchEndpoints(query: string, spec = loadSpec(), limit = 10): EndpointDoc[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = allEndpoints(spec).map((ep) => {
    const path = ep.path.toLowerCase();
    const summary = ep.summary.toLowerCase();
    const description = ep.description.toLowerCase();
    const tags = ep.tags.join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (path.includes(term)) score += 10;
      if (tags.includes(term)) score += 5;
      if (summary.includes(term)) score += 3;
      if (description.includes(term)) score += 1;
    }
    return { ep, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.ep.path.localeCompare(b.ep.path))
    .slice(0, limit)
    .map((s) => s.ep);
}
