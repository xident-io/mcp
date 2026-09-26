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
  it("has no pointer that an endpoint lookup leaves unresolved", () => {
    const endpoints = allEndpoints();
    expect(endpoints.length).toBeGreaterThan(50);
    const broken = endpoints
      .filter((ep) => JSON.stringify(ep).includes('"$unresolved"'))
      .map((ep) => `${ep.method} ${ep.path}`);
    expect(broken).toEqual([]);
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
    const deep = "github_com_xident-io_api_internal_domain_services.DataMatchCheckResult";
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
