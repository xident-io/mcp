import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bearerFrom, effectiveScopes, resolveToken } from "./auth.js";
import type { RuntimeConfig } from "./config.js";
import { challengeHeader, protectedResourceMetadata, SUPPORTED_SCOPES } from "./prm.js";
import { createRuntimeServer } from "./server.js";
import { toolsForScopes } from "./tools.js";

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Handle one HTTP request against the runtime server.
 *
 * Exported separately from the listener so the routing and auth behaviour can
 * be tested without binding a port.
 */
export async function handleRequest(
  cfg: RuntimeConfig,
  req: IncomingMessage,
  res: ServerResponse,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(req.url ?? "/", cfg.resourceUrl);

  // RFC 9728 discovery. Unauthenticated by necessity: a client fetches this
  // precisely because it does not yet have a token.
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    json(res, 200, protectedResourceMetadata(cfg), { "Cache-Control": "public, max-age=3600" });
    return;
  }

  if (url.pathname === "/healthz") {
    json(res, 200, { status: "ok" });
    return;
  }

  if (url.pathname !== "/mcp") {
    json(res, 404, { error: "not_found" });
    return;
  }

  const bearer = bearerFrom(req.headers.authorization);
  if (!bearer) {
    // The challenge carries resource_metadata, which is how a client with a
    // bare server URL discovers where to go and log in. A plain 401 would
    // leave it with nowhere to start.
    json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": challengeHeader(cfg) });
    return;
  }

  const auth = await resolveToken(cfg, bearer, fetchImpl);
  if (!auth.ok) {
    json(res, auth.status, { error: auth.error, error_description: auth.description }, {
      "WWW-Authenticate": challengeHeader(cfg, { error: auth.error, description: auth.description }),
    });
    return;
  }

  const scopes = effectiveScopes(auth, SUPPORTED_SCOPES);
  if (toolsForScopes(scopes).length === 0) {
    json(res, 403, {
      error: "insufficient_scope",
      error_description: "this token holds no scope that maps to a tool on this server",
    }, {
      "WWW-Authenticate": challengeHeader(cfg, {
        error: "insufficient_scope",
        scope: SUPPORTED_SCOPES.join(" "),
      }),
    });
    return;
  }

  // A server per request: the tool list depends on this caller's scopes.
  //
  // NOTE ON tsconfig: this package alone sets exactOptionalPropertyTypes:false.
  // The SDK's documented stateless mode requires passing `sessionIdGenerator:
  // undefined` EXPLICITLY, which that flag forbids. The rest of the workspace
  // keeps the stricter setting; relaxing it here is narrower than casting the
  // transport, which would hide any future genuine mismatch.
  const server = createRuntimeServer(cfg, bearer, scopes);
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

/** Start the listener. */
export function startHTTPServer(cfg: RuntimeConfig) {
  const server = createServer((req, res) => {
    handleRequest(cfg, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { error: "server_error" });
      }
      console.error("xident-mcp request failed:", err);
    });
  });
  server.listen(cfg.port, () => {
    console.error(`xident-mcp listening on :${cfg.port} as ${cfg.resourceUrl}`);
  });
  return server;
}
