import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { XidentClient } from "@xident/mcp-shared";
import type { RuntimeConfig } from "./config.js";
import { toolsForScopes } from "./tools.js";

export const SERVER_NAME = "xident";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a server for ONE authenticated caller.
 *
 * A server per request rather than one shared instance, because the tool list
 * depends on the scopes in that caller's token: a token without
 * verification:write must not even see xident_start_verification. Advertising a
 * tool the caller cannot use produces confident-looking failures and invites an
 * agent to retry something that will never succeed.
 */
export function createRuntimeServer(cfg: RuntimeConfig, bearerToken: string, scopes: readonly string[]): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // The server forwards the caller's own bearer token. It holds no tenant
  // credential of its own, so compromising this process yields nothing that
  // outlives the tokens currently in flight.
  const client = new XidentClient({ baseUrl: cfg.apiBaseUrl, apiKey: bearerToken });

  for (const tool of toolsForScopes(scopes)) {
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
          payload = await tool.handler(args ?? {}, client);
        } catch (err) {
          payload = {
            error: true,
            code: "TOOL_EXCEPTION",
            message: err instanceof Error ? err.message : String(err),
            retryable: false,
          };
        }
        // Structured JSON only. An agent handling identity data must receive
        // data it reports, never text it might read as instruction.
        return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
      },
    );
  }

  return server;
}
