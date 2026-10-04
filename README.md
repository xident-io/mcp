# Xident MCP servers and agent skill

Tools for building — and running — Xident age and identity verification from an
AI agent.

| Package | What it is |
|---|---|
| [`@xident/mcp-dev`](packages/mcp-dev) | **Build-time** MCP server. Docs lookup, sandbox test verifications, webhook debugging. Runs on a developer machine. |
| [`@xident/mcp`](packages/mcp) | **Runtime** MCP server for production agents — an OAuth 2.1 resource server. Holds no tenant credential; forwards the caller's token. |
| [`plugin/skills/xident-verification/`](plugin/skills/xident-verification) | Agent skill — teaches any agent to integrate Xident correctly. No runtime, no credentials. |
| [`plugin/`](plugin) | Claude Code plugin bundling the skill and the dev server. |

## Quick start

### Claude Code

```
/plugin marketplace add xident-io/mcp
/plugin install xident@xident-io
```

### Any MCP client

```json
{
  "mcpServers": {
    "xident-dev": {
      "command": "npx",
      "args": ["-y", "@xident/mcp-dev"],
      "env": { "XIDENT_API_KEY": "sk_test_your_sandbox_key" }
    }
  }
}
```

`XIDENT_API_KEY` is optional. Without it you still get `xident_search_docs`,
`xident_get_endpoint`, `xident_verify_webhook_signature`, and
`xident_explain_session` — enough to write a correct integration.

## Tools

| Tool | Key needed | Read-only |
|---|---|---|
| `xident_search_docs` | no | yes |
| `xident_get_endpoint` | no | yes |
| `xident_verify_webhook_signature` | no | yes |
| `xident_explain_session` | no* | yes |
| `xident_whoami` | sandbox | yes |
| `xident_start_test_verification` | sandbox | no |
| `xident_get_result` | sandbox | yes |
| `xident_simulate_webhook` | sandbox | no |
| `xident_check_integration` | sandbox | yes |

\* `xident_explain_session` needs a key only when you pass a token instead of a
reason code.

### Starting a test verification

`xident_start_test_verification` needs `callback_url`. For `age_verification`
(the default) it also needs `min_age`, a whole number from 12 to 25: Xident
rounds it up to the next of 12, 15, 18, 21 or 25, so 19 is enforced as 21. An
`id_verification` takes no `min_age` (leave it out or send 0) and cannot use
`verification_mode: facial`. Every session needs a `user_id`: leave it out and
the tool generates `mcp-dev-<random>`. End it with `+fail` to make the sandbox
session fail. A mistake gets the API's own error code from the tool, before any
request.

## What these servers deliberately cannot do

No tool deletes anything, writes to a fraud blacklist, or changes billing.
Specifically excluded: `DELETE /verify/v1/2fa/users/:id` (GDPR hard delete), all
blacklist writes, and any key or billing mutation. This is enforced by a test,
not a convention.

`xident_simulate_webhook` refuses any target that is not localhost, so it cannot
be used to make requests on someone else's behalf.

## Running agents in production

`@xident/mcp` is a remote MCP server. A tenant authorises a client through
Xident's consent screen, and the client calls the server with the resulting
bearer token. Tools outside the token's scopes are not advertised.

```bash
docker run -p 8080:8080 \
  -e XIDENT_MCP_RESOURCE_URL=https://mcp.yourdomain.com \
  ghcr.io/xident-io/mcp
```

See [packages/mcp](packages/mcp) for the full contract.

## Stability

Tool names and input schemas are **additive-only**, pinned by a golden test. A
rename is a broken promise, not a snapshot to regenerate.

One planned exception: from the API release that makes every session setting
server-only (xident-io/api#44), the start tools follow the API's init rules.
`user_id` is required, `min_age` is 12 to 25, and the dev tool requires
`callback_url`. The API refuses the old inputs from that release, so keeping
them would only move the error to the API call. The settings fields of the
start tools' schemas carry their types only (no required list, bounds or
enums): the tools check the rules themselves and answer with the API's error
codes, which an MCP schema failure would hide.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Licence

MIT
