import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DevContext } from "./context.js";
import { toolsFor } from "./tools/registry.js";

export const SERVER_NAME = "xident-dev";
export const SERVER_VERSION = "0.1.0";

/**
 * Build the MCP server for a context.
 *
 * Tool results are emitted as JSON text, never prose. An agent handling identity
 * data must receive data it reports, not sentences it might act on — see the
 * agent-safety section of the spec.
 */
export function createServer(ctx: DevContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of toolsFor(ctx)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        let payload: unknown;
        try {
          payload = await tool.handler(args ?? {}, ctx);
        } catch (err) {
          payload = {
            error: true,
            code: "TOOL_EXCEPTION",
            message: err instanceof Error ? err.message : String(err),
            fix: "This is a bug in @xident/mcp-dev. Please report it at https://github.com/xident-io/mcp/issues.",
            retryable: false,
          };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      },
    );
  }

  return server;
}
