# Xident MCP servers and agent skill

Tools for building — and running — Xident age and identity verification from an
AI agent.

| Package | What it is |
|---|---|
| [`@xident/mcp-dev`](packages/mcp-dev) | **Build-time** MCP server. Docs lookup, sandbox test verifications, webhook debugging. Runs on a developer machine. |
| [`@xident/mcp`](packages/mcp) | **Runtime** MCP server for production agents. OAuth-scoped. |
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

### Reading a result and deciding access

`xident_get_result` returns Xident's verdict verbatim. `verified` alone is not
a grant: pass `expected_user_id` (the user your backend started the
verification for) and `required_min_age` (your own setting, 12 to 25) and the
tool adds `access`:

- `proves_age`: `verified` is true, the result is not a test-key verdict, and
  `checks.age.gate` is present and at least `required_min_age`. It does not
  read `checks.age.passed`, which is false on a Xident ID reuse and an EU
  wallet pass. An `id_verification` result has no gate and never proves an age.
- `same_user`: `external_user_id` is `expected_user_id`.
- `test`, and `granted` (both checks pass).

Every result from this sandbox server is a test-key verdict, so `granted` is
false unless you pass `allow_test_results: true`. A production backend never
accepts a test verdict.

### Agent keys

`xident_whoami` and `xident_check_integration` accept an agent key (`ak_test_`)
as well as `sk_test_`. For an agent key they ask the API
(`GET /verify/v1/token-info`) which scopes it holds: with `verification:write`
it is ready, exactly like a sandbox secret key.

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
