# Xident failure reasons and errors

## Verification reasons

Present as `reason` when `status` is `failed`.

| Reason | Meaning | Who acts | Retry? |
|---|---|---|---|
| `age_below_threshold` | Verified age is under the configured gate | nobody | **No** — a correct refusal |
| `blacklist_match` | Face matched your fraud blacklist | nobody | **No** — a deliberate refusal |
| `liveness_failed` | Liveness challenge not passed | end user | Yes — retry in even lighting, follow the arrows |
| `face_mismatch` | Selfie did not match the document | end user | Yes — retake both; persistent failure warrants manual review |
| `document_rejected` | Document unsupported, unreadable, or failed authenticity | end user | Yes — retake, fill the frame, no glare |
| `dob_unreadable` | Document read, date of birth not extractable | end user | Yes — retake at higher resolution, data page flat |

**Never loop on `age_below_threshold` or `blacklist_match`.** They are the
product working. Retrying wastes money and, on the blacklist path, looks like an
attempt to evade a fraud control.

Unrecognised reason code? The server is newer than your integration. Treat it as
a non-retryable failure and check the changelog.

## HTTP errors

| Status | Code | Meaning | Remedy |
|---|---|---|---|
| 401 | — | Missing, malformed, or revoked key | Check the credential |
| 403 | `INSUFFICIENT_SCOPE` | Credential not authorized for this call | Scopes are fixed at issue time; use a key that has it |
| 402 | `ALLOWANCE_EXHAUSTED` | Included volume used up | Buy a pack or change tier — a human, in billing settings |
| 402 | `BUDGET_EXCEEDED` | Account hit a self-imposed spend budget | Raise or remove it in billing settings |
| 402 | `TENANT_SUSPENDED` | Account suspended, usually non-payment | Resolve billing |
| 404 | — | No such token for this tenant | Tokens are single-tenant and expire |
| 429 | — | Rate limited | Back off; honour `Retry-After` |
| 5xx | — | Server-side | Retry with exponential backoff |

`ALLOWANCE_EXHAUSTED` and `BUDGET_EXCEEDED` are distinct on purpose — the
remedies differ. Neither can be resolved by retrying, and neither can be
resolved by an automated caller. Surface them to a human.
