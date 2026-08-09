import { z } from "zod";
import { findEndpoint, searchEndpoints } from "@xident/mcp-shared";
import { fail, ok, type ToolDef } from "./types.js";

/** Search the API surface. Works offline — no key, no network. */
export const searchDocsTool: ToolDef = {
  name: "xident_search_docs",
  title: "Search Xident API",
  description:
    "Search Xident's API surface by keyword and return matching endpoints with their summaries. " +
    "Use this before writing any Xident integration code, so endpoint paths and shapes come from " +
    "the generated spec rather than from memory.",
  inputSchema: {
    query: z.string().min(1).describe("Keywords, e.g. 'init token' or 'webhook' or 'result'"),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiresKey: false,
  handler: async (args) => {
    const query = String(args["query"] ?? "");
    const limit = typeof args["limit"] === "number" ? args["limit"] : 10;
    const results = searchEndpoints(query, undefined, limit);
    return ok({
      query,
      count: results.length,
      endpoints: results.map((e) => ({
        path: e.path, method: e.method, summary: e.summary, tags: e.tags, auth: e.auth,
      })),
    });
  },
};

/** Full request/response schema for one endpoint. Works offline. */
export const getEndpointTool: ToolDef = {
  name: "xident_get_endpoint",
  title: "Get Xident endpoint schema",
  description:
    "Return the full request and response schema for one Xident endpoint, with $ref pointers " +
    "resolved. Use this instead of guessing field names.",
  inputSchema: {
    path: z.string().min(1).describe("Exact path, e.g. /verify/v1/init"),
    method: z.string().min(3).describe("HTTP method, e.g. POST"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiresKey: false,
  handler: async (args) => {
    const path = String(args["path"] ?? "");
    const method = String(args["method"] ?? "");
    const ep = findEndpoint(path, method);
    if (!ep) {
      const near = searchEndpoints(path.replace(/\//g, " "), undefined, 5);
      return fail(
        "ENDPOINT_NOT_FOUND",
        `No ${method.toUpperCase()} ${path} in the Xident API spec.`,
        near.length
          ? `Closest matches: ${near.map((e) => `${e.method} ${e.path}`).join(", ")}`
          : "Use xident_search_docs to find the right endpoint.",
      );
    }
    return ok(ep);
  },
};
