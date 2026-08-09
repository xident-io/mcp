# Xident MCP servers and agent skill

Tools for building — and running — Xident age and identity verification from an
AI agent.

| Package | What it is |
|---|---|
| [`@xident/mcp-dev`](packages/mcp-dev) | **Build-time** MCP server. Docs lookup, sandbox test verifications, webhook debugging. Runs on a developer machine. |
| [`@xident/mcp`](packages/mcp) | **Runtime** MCP server for production agents. OAuth-scoped. |
| [`skill/`](skill) | Agent skill — teaches any agent to integrate Xident correctly. No runtime, no credentials. |
| [`plugin/`](plugin) | Claude Code plugin bundling the skill and the dev server. |

## Quick start

### Claude Code

```
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

## What these servers deliberately cannot do

No tool deletes anything, writes to a fraud blacklist, or changes billing.
Specifically excluded: `DELETE /verify/v1/2fa/users/:id` (GDPR hard delete), all
blacklist writes, and any key or billing mutation. This is enforced by a test,
not a convention.

`xident_simulate_webhook` refuses any target that is not localhost, so it cannot
be used to make requests on someone else's behalf.

## Stability

Tool names and input schemas are **additive-only**, pinned by a golden test. A
rename is a broken promise, not a snapshot to regenerate.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Licence

MIT
