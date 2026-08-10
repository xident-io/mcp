# Xident integration reference

## Base URLs

| Environment | Base URL |
|---|---|
| Production | `https://api.xident.io` |
| Widget | `https://verify.xident.io` |

Sandbox is not a separate host — it is selected by using a `_test_` key.

## POST /verify/v1/init

Creates a verification session.

**Auth:** `Authorization: Bearer sk_...` (secret key required)

| Field | Type | Notes |
|---|---|---|
| `min_age` | int | Age gate for this session, e.g. `18` |
| `purpose` | string | `age_verification` (default) or `id_verification` |
| `verification_mode` | string | `auto` (default), `document` (forces ID + face match), `facial` (on-device only, never a document) |
| `user_id` | string | Your identifier for the subject, echoed back |
| `callback_url` | string | Where the widget returns the user |
| `success_url` / `failed_url` | string | Outcome-specific returns |
| `locale` | string | BCP-47, e.g. `de-DE` |
| `theme` | string | Widget theme |
| `metadata` | string | Opaque string echoed back |
| `liveness_difficulty` | string | Challenge strictness |

`verification_mode` composes with `min_age` rather than replacing it.

**Response 201:** `{ "success": true, "data": { "token", "verify_url" }, "meta": {} }`

Always send `Idempotency-Key`.

## GET /verify/v1/result/{token}

**Auth:** secret key required. A public key is rejected — this endpoint returns
tenant-only detail.

Returns the frozen v1 result inside `data`. The shape is additive-only: new
optional fields may appear, existing fields never change meaning. Write your
parser to ignore unknown fields.

## GET /verify/v1/status/{token}

The **subject-facing** view — less detail, masked failure reason. This is what
the widget uses. Do not use it for your own authorization decisions; use
`/result/{token}`.

## Polling

Poll `/result/{token}` with backoff. Terminal statuses: `success`, `failed`,
`expired`, `canceled`. Everything else may still change.

Prefer webhooks. Poll only as a fallback.

## Mobile

Open `verify_url` in a webview or browser and catch the callback. The secret key
stays on your backend; the app never holds it and never calls init or result.

## Errors

Errors use the same envelope:

```json
{ "success": false, "error": { "code": "ALLOWANCE_EXHAUSTED", "message": "..." }, "meta": {} }
```

Read `error.code`, not the message text.
