import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The bundled spec is Swagger 2.0 (not OpenAPI 3): body parameters live in
 * `parameters[in=body].schema`, and shared models live under `definitions`.
 * It is generated, not written by hand: swag reads the api's annotations, the
 * monorepo's scripts/openapi-public.py keeps the public part, and
 * `pnpm sync:openapi` (scripts/sync-openapi.mjs) copies that output here. The
 * copy is a manual step, so it can fall behind the API; `pnpm sync:openapi
 * --check` says whether it has.
 */
export interface SwaggerSpec {
  swagger: string;
  info: { title?: string; version?: string };
  host?: string;
  basePath?: string;
  paths: Record<string, Record<string, RawOperation>>;
  definitions?: Record<string, unknown>;
  /**
   * Shared parameters. scripts/openapi-public.py puts the X-API-Version header
   * here and points each /verify/ operation that the API's version middleware
   * runs on at it with `{"$ref": "#/parameters/XApiVersion"}`: the operations
   * that take an API key (53 of 59 /verify/ operations on 2026-09-26), not the
   * unauthenticated ones.
   */
  parameters?: Record<string, unknown>;
  /** Shared responses. Swagger 2.0 allows them; the current spec has none. */
  responses?: Record<string, unknown>;
  /** How each security scheme named in an operation's `security` is sent. */
  securityDefinitions?: Record<string, SecurityScheme>;
}

interface SecurityScheme {
  type?: string;
  in?: string;
  name?: string;
  description?: string;
}

/** One credential an endpoint needs, and where to send it. */
export interface Credential {
  /** The spec's scheme name, e.g. "ApiKeyAuth" or "AccountToken". */
  scheme: string;
  /** "header" or "query"; absent when the spec does not say. */
  in?: string;
  /** The header or query parameter name, e.g. "X-API-Key". */
  name?: string;
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
  /**
   * Short label for the auth the endpoint needs, from its security block:
   * "api_key", "api_key+account_token" (both sent together), "none", or
   * "unknown" when the spec says nothing or its security block is malformed.
   * Alternatives are joined with " or ".
   */
  auth: string;
  /**
   * Every accepted way to authenticate, with the header names. Each inner
   * list is one requirement whose credentials are all sent together (Swagger
   * 2.0: the objects of `security` are alternatives, the keys of one object
   * are combined). Empty when the endpoint needs no auth; null when the spec
   * does not say, or says it in a malformed block.
   */
  security: Credential[][] | null;
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

/**
 * How many `$ref` hops resolveRefs follows along one chain before it stops.
 * Hops are counted separately from nesting: an envelope such as
 * responses > 200 > schema > allOf > data is many levels deep but only one
 * hop. The deepest chain in the bundled spec is 4 hops (2026-09-26); cycles
 * are caught by `seen`, so this is a safety net, and hitting it leaves an
 * explicit `$truncated` marker, never a raw `$ref`.
 */
export const MAX_REF_HOPS = 16;

/**
 * How many levels of objects and arrays resolveRefs goes down, counted from
 * the value it was given and through followed pointers alike. The deepest
 * endpoint output of the bundled spec is 17 levels (GET
 * /verify/v1/result/{token}, 2026-11-14). The limit is there because nesting
 * alone, with no pointer at all (items > items > ... thousands of times),
 * would otherwise overflow the call stack; hitting it leaves a `$truncated`
 * marker, as MAX_REF_HOPS does.
 */
export const MAX_NESTING = 64;

/**
 * Follow a local pointer such as `#/definitions/Foo` or
 * `#/parameters/XApiVersion` from the top of the spec, one path segment at a
 * time, so every top-level section works, not only `definitions`. Segments are
 * unescaped as JSON Pointer says (`~1` is `/`, `~0` is `~`).
 *
 * Returns undefined when the pointer is not local (`other.json#/...`), names a
 * whole section instead of one entry (`#/definitions`), or names something the
 * spec does not have. Only the object's own keys are followed, so
 * `#/definitions/constructor` is not found on Object.prototype.
 */
function lookupPointer(ref: string, spec: SwaggerSpec): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length < 2) return undefined;

  let node: unknown = spec;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Replace `$ref` pointers with what they point to (a model under
 * `definitions`, a shared header under `parameters`, and so on), so a caller
 * gets a usable schema instead of a pointer it would have to chase.
 *
 * The output never contains a raw `$ref`. A pointer that cannot be followed
 * becomes one of three markers:
 * - `{ $circular: ref }`: the pointer is already being resolved further up
 *   this chain (Xident's models are self-referential in places);
 * - `{ $unresolved: ref }`: it points at nothing in the spec;
 * - `{ $truncated: ref }`: the chain is already MAX_REF_HOPS hops long.
 * An object or array more than MAX_NESTING levels down becomes
 * `{ $truncated: "nested deeper than 64 levels" }`.
 * A cycle is tracked by the full pointer, so `#/parameters/Foo` and
 * `#/definitions/Foo` are two different things, not a loop. `hops` counts
 * pointers followed; `depth` counts levels of nesting, and a followed pointer
 * does not add one, because its target takes the pointer's place.
 */
export function resolveRefs(
  node: unknown,
  spec: SwaggerSpec,
  hops = 0,
  seen: ReadonlySet<string> = new Set(),
  depth = 0,
): unknown {
  if (node === null || typeof node !== "object") return node;
  if (depth >= MAX_NESTING) return { $truncated: `nested deeper than ${MAX_NESTING} levels` };

  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, spec, hops, seen, depth + 1));
  }

  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string") {
    if (seen.has(ref)) return { $circular: ref };
    if (hops >= MAX_REF_HOPS) return { $truncated: ref };
    const target = lookupPointer(ref, spec);
    if (target === undefined) return { $unresolved: ref };
    return resolveRefs(target, spec, hops + 1, new Set([...seen, ref]), depth);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = resolveRefs(value, spec, hops, seen, depth + 1);
  }
  return out;
}

/** Short labels for the security schemes the Xident spec defines. */
const SCHEME_LABELS: Record<string, string> = {
  ApiKeyAuth: "api_key",
  AccountToken: "account_token",
  BearerAuth: "bearer",
};

/** The API key first (it is always the tenant's credential), then by name. */
function byApiKeyFirst(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "ApiKeyAuth" || a === "api_key") return -1;
  if (b === "ApiKeyAuth" || b === "api_key") return 1;
  return a.localeCompare(b);
}

/**
 * One Swagger 2.0 security requirement: an object whose every value is a list
 * of scope names. `{}` is one too: an alternative that needs no credential.
 */
function isRequirement(value: unknown): value is Record<string, string[]> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((scopes) => Array.isArray(scopes) && scopes.every((s) => typeof s === "string"))
  );
}

/**
 * The operation's security requirements, each with the header (or query
 * parameter) its credentials go in. null when the operation has no security
 * block, and also when the block is not a list of requirements or any entry
 * is malformed (`[null]`, `[42]`, `"x"`, `{}`): a block that cannot be read
 * says nothing, and must never read as "no credentials needed".
 * scripts/sync-openapi.mjs refuses such a spec; this is the second line.
 */
function securityOf(op: RawOperation, spec: SwaggerSpec): Credential[][] | null {
  if (!Array.isArray(op.security) || !op.security.every(isRequirement)) return null;
  const defs = spec.securityDefinitions;
  return op.security.map((requirement) =>
    Object.keys(requirement)
      .sort(byApiKeyFirst)
      .map((scheme) => {
        // Own keys only: a scheme named "constructor" must not find Object.
        // A null or non-object securityDefinitions gives no definition, never a throw.
        const def =
          defs !== null && typeof defs === "object" && Object.hasOwn(defs, scheme) ? defs[scheme] : undefined;
        const credential: Credential = { scheme };
        if (typeof def?.in === "string") credential.in = def.in;
        if (typeof def?.name === "string") credential.name = def.name;
        return credential;
      }),
  );
}

/** The short auth label, in the same order as `security`. */
function authOf(security: Credential[][] | null): string {
  if (security === null) return "unknown";
  if (security.length === 0) return "none";
  const label = (scheme: string) => (Object.hasOwn(SCHEME_LABELS, scheme) ? SCHEME_LABELS[scheme] : scheme);
  return security
    .map((requirement) => (requirement.length === 0 ? "none" : requirement.map((c) => label(c.scheme)).join("+")))
    .join(" or ");
}

function toDoc(path: string, method: string, op: RawOperation, spec: SwaggerSpec): EndpointDoc {
  const security = securityOf(op, spec);
  return {
    path,
    method: method.toUpperCase(),
    summary: op.summary ?? "",
    description: op.description ?? "",
    tags: op.tags ?? [],
    auth: authOf(security),
    security,
    parameters: (resolveRefs(op.parameters ?? [], spec) as unknown[]),
    responses: (resolveRefs(op.responses ?? {}, spec) as Record<string, unknown>),
  };
}

/**
 * Exact lookup. Returns null for an unknown path or method — never throws.
 * Only the spec's own keys count, and only HTTP methods: a path or method
 * such as "__proto__" or "constructor" must not reach Object.prototype, and a
 * path item's shared "parameters" list is not an operation.
 */
export function findEndpoint(path: string, method: string, spec = loadSpec()): EndpointDoc | null {
  if (!Object.hasOwn(spec.paths, path)) return null;
  const ops = spec.paths[path];
  const key = method.toLowerCase();
  if (!ops || !HTTP_METHODS.has(key) || !Object.hasOwn(ops, key)) return null;
  const op = ops[key];
  if (!op || typeof op !== "object") return null;
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
