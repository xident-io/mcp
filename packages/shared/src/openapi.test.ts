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

/**
 * The bundled spec is what xident_get_endpoint and xident_search_docs serve.
 * It used to describe the old init rules: no required user_id, any age, and
 * settings in the URL of /requirements/check, so an agent that followed it
 * got MISSING_USER_ID or MISSING_INIT_TOKEN from the API (Astra finding 1).
 * These pin the rules of api PR #44 so the drift cannot come back unnoticed.
 */
describe("bundled spec: the init and requirements rules of api PR #44", () => {
  type Schema = { required?: string[]; properties: Record<string, Record<string, unknown>> };
  type Param = { name: string; in: string; required?: boolean; schema?: Schema };

  function bodySchema(path: string, method: string): Schema {
    const params = findEndpoint(path, method)!.parameters as Param[];
    return params.find((p) => p.in === "body")!.schema!;
  }

  it("POST /verify/v1/init requires user_id and callback_url", () => {
    expect(bodySchema("/verify/v1/init", "post").required).toEqual(expect.arrayContaining(["callback_url", "user_id"]));
  });

  it("POST /verify/v1/init bounds min_age and states the band rule", () => {
    const minAge = bodySchema("/verify/v1/init", "post").properties["min_age"]!;
    expect(minAge["maximum"]).toBe(25);
    expect(minAge["minimum"]).toBe(0);
    expect(String(minAge["description"])).toContain("12 to 25");
    expect(String(minAge["description"])).toContain("19 is enforced as 21");
    expect(String(minAge["description"])).toContain("id_verification takes none");
  });

  it("POST /verify/v1/init lists the purposes and modes, and the facial rule", () => {
    const props = bodySchema("/verify/v1/init", "post").properties;
    expect(props["purpose"]!["enum"]).toEqual(["age_verification", "id_verification"]);
    expect(props["verification_mode"]!["enum"]).toEqual(["auto", "document", "facial"]);
    expect(String(props["verification_mode"]!["description"])).toContain("refused with purpose id_verification");
  });

  it("POST /verify/v1/init says it needs a server key", () => {
    const ep = findEndpoint("/verify/v1/init", "post")!;
    expect(ep.description).toContain("SECRET_KEY_REQUIRED");
    expect(ep.description).toContain("user_id is required");
    expect(Object.keys(ep.responses)).toContain("403");
  });

  it.each([["/verify/v1/requirements/check"], ["/verify/v1/requirements"]])(
    "GET %s takes the init token in X-Init-Token and no settings in the URL", (path) => {
      const params = findEndpoint(path, "get")!.parameters as Param[];
      expect(params.find((p) => p.name === "X-Init-Token")).toMatchObject({ in: "header", required: true });
      expect(params.filter((p) => p.in === "query")).toEqual([]);
    });

  it("GET /verify/v1/requirements/check names the new refusals", () => {
    const ep = findEndpoint("/verify/v1/requirements/check", "get")!;
    expect(ep.description).toContain("MISSING_INIT_TOKEN");
    expect(ep.description).toContain("INIT_TOKEN_KEY_MISMATCH");
  });

  it("leaves no reference the bundled resolver cannot follow on these paths", () => {
    for (const [path, method] of [
      ["/verify/v1/init", "post"], ["/verify/v1/init/{token}", "get"],
      ["/verify/v1/requirements/check", "get"], ["/verify/v1/requirements", "get"],
    ] as const) {
      expect(JSON.stringify(findEndpoint(path, method)), path).not.toContain("$unresolved");
    }
  });
});
