import { describe, expect, it } from "vitest";
import { allEndpoints, findEndpoint, loadSpec, resolveRefs, searchEndpoints } from "./openapi.js";

describe("loadSpec", () => {
  it("loads the bundled Swagger 2.0 spec", () => {
    const spec = loadSpec();
    expect(spec.swagger).toBe("2.0");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(50);
  });
});

describe("findEndpoint", () => {
  it("finds the init endpoint every integration uses", () => {
    const ep = findEndpoint("/verify/v1/init", "post");
    expect(ep).not.toBeNull();
    expect(ep!.method).toBe("POST");
    expect(ep!.auth).toBe("api_key");
    expect(ep!.security).toEqual([[{ scheme: "ApiKeyAuth", in: "header", name: "X-API-Key" }]]);
  });

  it("is case-insensitive on the method", () => {
    expect(findEndpoint("/verify/v1/init", "POST")).not.toBeNull();
  });

  it("returns null for an unknown path rather than throwing", () => {
    expect(findEndpoint("/verify/v1/does-not-exist", "get")).toBeNull();
  });

  it("returns null for a method the path does not serve", () => {
    expect(findEndpoint("/verify/v1/init", "delete")).toBeNull();
  });

  it("looks up only the spec's own keys, never Object.prototype", () => {
    for (const path of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(findEndpoint(path, "get"), path).toBeNull();
    }
    for (const method of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(findEndpoint("/verify/v1/init", method), method).toBeNull();
    }
    // Both halves inherited: Object.prototype.constructor is a function.
    expect(findEndpoint("__proto__", "constructor")).toBeNull();
    expect(findEndpoint("constructor", "constructor")).toBeNull();
    // A path the paths object only inherits is not in the spec.
    const inherited = {
      swagger: "2.0", info: {},
      paths: Object.create({ "/inherited": { get: { summary: "not in the spec" } } }),
    } as never;
    expect(findEndpoint("/inherited", "get", inherited)).toBeNull();
  });

  it("does not take a path item's shared parameters for an operation", () => {
    const spec = {
      swagger: "2.0", info: {},
      paths: { "/x": { parameters: [{ name: "id", in: "path" }], get: { summary: "x" } } },
    } as never;
    expect(findEndpoint("/x", "parameters", spec)).toBeNull();
    expect(findEndpoint("/x", "get", spec)).not.toBeNull();
  });
});

/** Every object key anywhere in `node`. */
function keysIn(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const v of node) keysIn(v, out);
  else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      keysIn(v, out);
    }
  }
  return out;
}

/** Follow keys and array indexes; undefined when a step is missing. */
function dig(node: unknown, ...steps: Array<string | number>): unknown {
  let cur = node;
  for (const step of steps) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[step];
  }
  return cur;
}

describe("auth", () => {
  const spec = (security: unknown) =>
    ({
      swagger: "2.0", info: {},
      securityDefinitions: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
        BearerAuth: { type: "apiKey", in: "header", name: "Authorization" },
        AccountToken: { type: "apiKey", in: "header", name: "X-Account-Token" },
      },
      paths: { "/x": { get: security === undefined ? {} : { security } } },
    }) as never;

  it("is none, with no requirements, for an empty security list", () => {
    const ep = findEndpoint("/x", "get", spec([]))!;
    expect(ep.auth).toBe("none");
    expect(ep.security).toEqual([]);
  });

  it("is unknown, with security null, when the spec says nothing", () => {
    const ep = findEndpoint("/x", "get", spec(undefined))!;
    expect(ep.auth).toBe("unknown");
    expect(ep.security).toBeNull();
  });

  it("joins credentials of one requirement with + and alternatives with ' or '", () => {
    const both = findEndpoint("/x", "get", spec([{ AccountToken: [], ApiKeyAuth: [] }]))!;
    expect(both.auth).toBe("api_key+account_token");
    const either = findEndpoint("/x", "get", spec([{ ApiKeyAuth: [] }, { BearerAuth: [] }]))!;
    expect(either.auth).toBe("api_key or bearer");
    expect(either.security).toEqual([
      [{ scheme: "ApiKeyAuth", in: "header", name: "X-API-Key" }],
      [{ scheme: "BearerAuth", in: "header", name: "Authorization" }],
    ]);
  });

  it("keeps a scheme the spec does not define, by name", () => {
    const ep = findEndpoint("/x", "get", spec([{ Mystery: [] }]))!;
    expect(ep.auth).toBe("Mystery");
    expect(ep.security).toEqual([[{ scheme: "Mystery" }]]);
  });
});

describe("resolveRefs", () => {
  it("inlines a definition instead of leaving a pointer", () => {
    const spec = loadSpec();
    const name = Object.keys(spec.definitions ?? {})[0]!;
    const resolved = resolveRefs({ $ref: `#/definitions/${name}` }, spec) as Record<string, unknown>;
    expect(resolved["$ref"]).toBeUndefined();
  });

  it("marks an unresolvable pointer rather than throwing", () => {
    const resolved = resolveRefs({ $ref: "#/definitions/NoSuchThing" }, loadSpec()) as Record<string, unknown>;
    expect(resolved["$unresolved"]).toBe("#/definitions/NoSuchThing");
  });

  it("terminates on a self-referential definition", () => {
    const spec = {
      swagger: "2.0", info: {}, paths: {},
      definitions: { Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } } },
    } as never;
    const resolved = resolveRefs({ $ref: "#/definitions/Node" }, spec) as Record<string, unknown>;
    expect(JSON.stringify(resolved)).toContain("$circular");
  });

  it("counts pointer hops, not nesting: a deep envelope with two hops resolves fully", () => {
    const spec = {
      swagger: "2.0", info: {}, paths: {},
      definitions: {
        Envelope: { type: "object", properties: { success: { type: "boolean" } } },
        Result: { type: "object", properties: { checks: { $ref: "#/definitions/Checks" } } },
        Checks: { type: "object", properties: { age: { type: "string" } } },
      },
    } as never;
    // responses > 200 > schema > allOf > [1] > properties > data: seven levels, one hop to Result.
    const responses = {
      200: { schema: { allOf: [{ $ref: "#/definitions/Envelope" }, { properties: { data: { $ref: "#/definitions/Result" } } }] } },
    };
    const out = resolveRefs(responses, spec);
    expect(dig(out, 200, "schema", "allOf", 1, "properties", "data", "properties", "checks", "properties", "age"))
      .toEqual({ type: "string" });
    expect(keysIn(out).has("$ref")).toBe(false);
  });

  it("stops a very long chain with a $truncated marker, never a raw $ref", () => {
    const definitions: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      definitions[`D${i}`] = { type: "object", properties: { next: { $ref: `#/definitions/D${i + 1}` } } };
    }
    definitions["D40"] = { type: "string" };
    const spec = { swagger: "2.0", info: {}, paths: {}, definitions } as never;
    const out = resolveRefs({ $ref: "#/definitions/D0" }, spec);
    const keys = keysIn(out);
    expect(keys.has("$ref")).toBe(false);
    expect(keys.has("$truncated")).toBe(true);
    expect(JSON.stringify(out)).toMatch(/"\$truncated":"#\/definitions\/D\d+"/);
  });

  it("follows a pointer into the shared parameters section", () => {
    const header = { name: "X-API-Version", in: "header", type: "string", required: false };
    const spec = { swagger: "2.0", info: {}, paths: {}, parameters: { XApiVersion: header } } as never;
    expect(resolveRefs({ $ref: "#/parameters/XApiVersion" }, spec)).toEqual(header);
  });

  it("follows a pointer into any other top-level section, such as responses", () => {
    const notFound = { description: "Not found" };
    const spec = { swagger: "2.0", info: {}, paths: {}, responses: { NotFound: notFound } } as never;
    expect(resolveRefs({ $ref: "#/responses/NotFound" }, spec)).toEqual(notFound);
  });

  it("does not take the same name in two sections for a loop", () => {
    const spec = {
      swagger: "2.0", info: {}, paths: {},
      parameters: { Body: { name: "body", in: "body", schema: { $ref: "#/definitions/Body" } } },
      definitions: { Body: { type: "object" } },
    } as never;
    expect(resolveRefs({ $ref: "#/parameters/Body" }, spec)).toEqual({
      name: "body", in: "body", schema: { type: "object" },
    });
  });

  it("does not find inherited object properties", () => {
    expect(resolveRefs({ $ref: "#/definitions/constructor" }, loadSpec())).toEqual({
      $unresolved: "#/definitions/constructor",
    });
  });

  it("marks a pointer to a whole section or to a file as unresolved", () => {
    const spec = { swagger: "2.0", info: {}, paths: {}, definitions: { Foo: { type: "object" } } } as never;
    expect(resolveRefs({ $ref: "#/definitions" }, spec)).toEqual({ $unresolved: "#/definitions" });
    // A relative file path, not a pointer into this spec, even though its tail looks like one.
    expect(resolveRefs({ $ref: "./definitions/Foo" }, spec)).toEqual({ $unresolved: "./definitions/Foo" });
  });

  it("decodes the JSON Pointer escapes ~1 (a slash) and ~0 (a tilde)", () => {
    const spec = {
      swagger: "2.0", info: {}, paths: {},
      definitions: {
        "a/b": { title: "slash" },
        "a~b": { title: "tilde" },
        "a~1": { title: "tilde then one" },
        "a/": { title: "slash at the end" },
      },
    } as never;
    expect(resolveRefs({ $ref: "#/definitions/a~1b" }, spec)).toEqual({ title: "slash" });
    expect(resolveRefs({ $ref: "#/definitions/a~0b" }, spec)).toEqual({ title: "tilde" });
    // RFC 6901: ~1 is decoded before ~0, so "~01" is a tilde followed by "1",
    // not a slash.
    expect(resolveRefs({ $ref: "#/definitions/a~01" }, spec)).toEqual({ title: "tilde then one" });
  });
});

type Json = unknown;

/**
 * Follows a local JSON pointer on its own, without resolveRefs: returns
 * undefined when any segment is missing. Written separately so the check
 * below does not trust the code it checks.
 */
function pointerTarget(spec: Json, ref: string): Json {
  if (!ref.startsWith("#/")) return undefined;
  let node: Json = spec;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (node === null || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, key)) {
      return undefined;
    }
    node = (node as Record<string, Json>)[key];
  }
  return node;
}

/**
 * Every "$ref" reachable from the operation at spec.paths[path][method],
 * followed through the spec to any depth, with the ones that point at
 * nothing. Independent of resolveRefs and of its depth limit.
 */
function brokenRefs(spec: Json, path: string, method: string): string[] {
  const paths = (spec as { paths: Record<string, Record<string, Json>> }).paths;
  const broken: string[] = [];
  const seen = new Set<string>();
  const stack: Json[] = [paths[path]![method]];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, Json>)) {
      if (key === "$ref" && typeof value === "string") {
        if (seen.has(value)) continue;
        seen.add(value);
        const target = pointerTarget(spec, value);
        if (target === undefined) broken.push(value);
        else stack.push(target);
      } else {
        stack.push(value);
      }
    }
  }
  return broken;
}

function operations(spec: Json): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [path, ops] of Object.entries((spec as { paths: Record<string, Record<string, Json>> }).paths)) {
    for (const method of Object.keys(ops)) {
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) out.push([path, method]);
    }
  }
  return out;
}

describe("the bundled spec", () => {
  it("leaves no raw $ref and no $unresolved or $truncated marker in any endpoint output", () => {
    // $circular is fine: it marks a real self-reference, which cannot be inlined.
    const endpoints = allEndpoints();
    expect(endpoints.length).toBeGreaterThan(50);
    const found = endpoints.flatMap((ep) =>
      [...keysIn(ep)]
        .filter((k) => k === "$ref" || k === "$unresolved" || k === "$truncated")
        .map((k) => `${ep.method} ${ep.path}: ${k}`),
    );
    expect(found).toEqual([]);
  });

  it("resolves the result behind the {success, data, meta} envelope all the way down", () => {
    const ep = findEndpoint("/verify/v1/result/{token}", "get")!;
    const data = dig(ep.responses, "200", "schema", "allOf", 1, "properties", "data", "properties") as Record<string, unknown>;
    // Four hops deep: TenantResult > ResultChecks > DataMatchCheckResult > DataMatchFields.
    expect(dig(data, "checks", "properties", "data_match", "allOf", 0, "properties", "fields", "properties", "first_name"))
      .toEqual({ type: "string" });
    expect(dig(data, "risk", "allOf", 0, "properties", "band")).toEqual({ type: "string" });
  });

  it("keeps the deep fields of GET /public/v1/status", () => {
    expect(JSON.stringify(findEndpoint("/public/v1/status", "get"))).toContain('"latency_ms"');
  });

  it("names both credentials and their headers for POST /verify/v1/accounts/reuse", () => {
    const ep = findEndpoint("/verify/v1/accounts/reuse", "post")!;
    expect(ep.auth).toBe("api_key+account_token");
    expect(ep.security).toEqual([
      [
        { scheme: "ApiKeyAuth", in: "header", name: "X-API-Key" },
        { scheme: "AccountToken", in: "header", name: "X-Account-Token" },
      ],
    ]);
  });

  it("names the account token on every route that needs one", () => {
    // The API checks X-API-Key AND the account token on these routes (the
    // accountAuthed group); api#29 publishes both, in one requirement.
    for (const [method, path] of [
      ["post", "/verify/v1/accounts/reuse"],
      ["get", "/verify/v1/accounts/me"],
      ["delete", "/verify/v1/accounts/me"],
      ["get", "/verify/v1/accounts/connections"],
      ["post", "/verify/v1/accounts/passkey/register/begin"],
      ["post", "/verify/v1/accounts/passkey/register/finish"],
      ["get", "/verify/v1/accounts/passkeys"],
      ["delete", "/verify/v1/accounts/passkeys/{id}"],
      ["post", "/verify/v1/verification-tokens/issue"],
      ["post", "/verify/v1/verification-tokens/revoke"],
    ] as const) {
      const ep = findEndpoint(path, method)!;
      expect(ep, `${method} ${path}`).not.toBeNull();
      expect(ep.auth, `${method} ${path}`).toBe("api_key+account_token");
    }
  });

  it("says an unauthenticated endpoint documents no security", () => {
    const ep = findEndpoint("/verify/v1/init/{token}", "get")!;
    expect(ep.auth).toBe("unknown");
    expect(ep.security).toBeNull();
  });

  it("has no local $ref, at any depth from any endpoint, that points at nothing", () => {
    const spec = loadSpec();
    const ops = operations(spec);
    expect(ops.length).toBeGreaterThan(50);
    const broken = ops.flatMap(([path, method]) =>
      brokenRefs(spec, path, method).map((ref) => `${method.toUpperCase()} ${path} -> ${ref}`),
    );
    expect(broken).toEqual([]);
  });

  it("the check above notices a definition that an endpoint reaches deep down", () => {
    // Guards the check itself: remove a definition that resolveRefs does not
    // reach from this endpoint today (it stops at depth 6), and the walk still
    // reports it.
    const spec = structuredClone(loadSpec()) as unknown as {
      definitions: Record<string, unknown>;
    };
    const deep = "DataMatchCheckResult";
    expect(spec.definitions[deep]).toBeDefined();
    delete spec.definitions[deep];
    expect(brokenRefs(spec, "/verify/v1/result/{token}", "get")).toEqual([`#/definitions/${deep}`]);
  });

  it("shows the X-API-Version header on a /verify/ endpoint", () => {
    const ep = findEndpoint("/verify/v1/liveness/verify", "post");
    expect(ep).not.toBeNull();
    expect(ep!.parameters).toContainEqual(
      expect.objectContaining({ name: "X-API-Version", in: "header", type: "string" }),
    );
  });
});

describe("searchEndpoints", () => {
  it("ranks a path match above a prose match", () => {
    const results = searchEndpoints("init");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toContain("init");
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(searchEndpoints("   ")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(searchEndpoints("verify", undefined, 3).length).toBeLessThanOrEqual(3);
  });
});

describe("allEndpoints", () => {
  it("skips non-method keys such as parameters", () => {
    for (const ep of allEndpoints()) {
      expect(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).toContain(ep.method);
    }
  });
});
