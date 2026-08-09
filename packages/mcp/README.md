# @xident/mcp — Xident runtime MCP server

For **production AI agents** that verify real people. For building an
integration, use [`@xident/mcp-dev`](../mcp-dev) instead.

## What it is

An OAuth 2.1 **resource server**. A tenant authorises an MCP client through
Xident's consent screen; the client then calls this server with the resulting
bearer token.

This process holds **no tenant credential of its own** — it forwards the
caller's token. Compromising it yields nothing that outlives the tokens
currently in flight.

## Tools

| Tool | Scope |
|---|---|
| `xident_get_verification_result` | `verification:read` |
| `xident_start_verification` | `verification:write` |
| `xident_verify_face_2fa` | `2fa:verify` |
| `xident_list_blacklist` | `blacklist:read` |

Tools a token's scopes do not cover are **not advertised**, so an agent never
sees a tool it cannot use.

## What it cannot do, by design

No tool deletes a 2FA enrollment, writes to the fraud blacklist, or changes
billing. Those operations have no scope in the vocabulary, and the API refuses
them for agent credentials regardless of what this server offers. Both halves
are enforced by tests.

## Endpoints

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 discovery |
| `/mcp` | The MCP endpoint (bearer required) |
| `/healthz` | Liveness |

## Self-hosting

```bash
docker run -p 8080:8080 \
  -e XIDENT_MCP_RESOURCE_URL=https://mcp.yourdomain.com \
  -e XIDENT_API_BASE_URL=https://api.xident.io \
  -e XIDENT_ISSUER=https://api.xident.io/agent \
  ghcr.io/xident-io/mcp
```

`XIDENT_MCP_RESOURCE_URL` must be the URL clients actually reach, because access
tokens are bound to it (RFC 8707) and a mismatch rejects every request.

## Stability

Tool names, scopes, and input schemas are **additive-only**, pinned by a golden
test. A rename or a scope change fails the build.

## Licence

MIT
