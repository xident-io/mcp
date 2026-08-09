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
