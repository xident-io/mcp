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
});

describe("the bundled spec", () => {
  it("has no pointer that an endpoint lookup leaves unresolved", () => {
    const endpoints = allEndpoints();
    expect(endpoints.length).toBeGreaterThan(50);
    const broken = endpoints
      .filter((ep) => JSON.stringify(ep).includes('"$unresolved"'))
      .map((ep) => `${ep.method} ${ep.path}`);
    expect(broken).toEqual([]);
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
