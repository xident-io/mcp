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

### Reading a result and deciding access

`xident_get_verification_result` returns Xident's verdict verbatim. `verified`
alone is not a grant: pass `expected_user_id` (the user your backend started
the verification for) and `required_min_age` (your own setting, 12 to 25) and
the tool adds `access` with `proves_age` (verified, not a test-key verdict,
`checks.age.gate` present and at least `required_min_age`; `checks.age.passed`
is not read, because it is false on a Xident ID reuse and an EU wallet pass),
`same_user` (`external_user_id` matches), `test` and `granted`. This server has
no opt-in for test-key verdicts: they never grant.

### Starting a verification

`xident_start_verification` needs `callback_url`, `user_id` (your own
identifier for the person being verified) and `idempotency_key`. For
`age_verification` (the default) it also needs `min_age`, a whole number from
12 to 25: Xident rounds it up to the next of 12, 15, 18, 21 or 25, so 19 is
enforced as 21. An `id_verification` takes no `min_age` (leave it out or send
0) and cannot use `verification_mode: facial`. The tool refuses these mistakes
before calling the API, with the same error code the API would send
(`MISSING_CALLBACK_URL`, `MISSING_USER_ID`, `INVALID_PURPOSE`,
`INVALID_MIN_AGE`, `INVALID_VERIFICATION_MODE`). The input schema gives these
fields their types only, so the tool, not the MCP schema check, answers a
mistake, and the agent gets the API's code.

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

One planned exception: from the API release that makes every session setting
server-only (xident-io/api#44), `xident_start_verification` follows the API's
init rules: `user_id` is required and `min_age` is 12 to 25. The API refuses the
old inputs from that release, so keeping them would only move the error to the
API call. The settings fields of the schema carry their types only (no required
list, bounds or enums): the tool checks the rules itself and answers with the
API's error codes.

## Licence

MIT
