#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contextFromEnv } from "./context.js";
import { createServer } from "./server.js";
import { toolsFor } from "./tools/registry.js";

async function main(): Promise<void> {
  const ctx = contextFromEnv(process.env);
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());

  // stderr only — stdout is the MCP transport and must carry nothing else.
  const count = toolsFor(ctx).length;
  const mode = ctx.client ? (ctx.sandbox ? "sandbox key" : "LIVE key (write tools disabled)") : "no key (offline tools only)";
  console.error(`xident-dev MCP server ready — ${count} tools, ${mode}, base ${ctx.baseUrl}`);
}

main().catch((err: unknown) => {
  console.error("xident-dev failed to start:", err);
  process.exit(1);
});
