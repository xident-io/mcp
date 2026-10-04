# Xident integration reference

## Base URLs

| Environment | Base URL |
|---|---|
| Production | `https://api.xident.io` |
| Widget | `https://verify.xident.io` |

Sandbox is not a separate host — it is selected by using a `_test_` key.

## POST /verify/v1/init

Creates a verification session.

**Auth:** `Authorization: Bearer sk_...` (a server key: `sk_live_`, `sk_test_`,
`ak_live_` or `ak_test_`). A public key (`pk_`) gets 403 `SECRET_KEY_REQUIRED`.

| Field | Type | Notes |
|---|---|---|
| `callback_url` | string | **Required.** Where the widget returns the user |
| `user_id` | string | **Required.** Your own identifier for the person being verified. It comes back on the callback and in the result |
| `min_age` | int | **Required for `age_verification`.** A whole number from 12 to 25, rounded up to the next of 12, 15, 18, 21 or 25 (19 is enforced as 21). `id_verification` takes none: leave it out or send 0 |
| `purpose` | string | `age_verification` (default) or `id_verification` (a document and a face match, no age threshold) |
| `verification_mode` | string | `auto` (default), `document` (forces ID + face match), `facial` (on-device only, never a document). `facial` cannot be combined with `id_verification` |
| `success_url` / `failed_url` | string | Outcome-specific returns |
| `locale` | string | BCP-47, e.g. `de-DE` |
| `theme` | string | Widget theme |
| `metadata` | string | Opaque string echoed back |
| `liveness_difficulty` | string | `easy` (default), `medium` or `hard` |

`verification_mode` composes with `min_age` rather than replacing it.

Every setting of the session comes from this call. The widget cannot change
them, so they must be decided on your server.

**Refusals:** 400 `MISSING_USER_ID`, 400 `INVALID_MIN_AGE`, 400
`INVALID_VERIFICATION_MODE`, 400 `INVALID_LIVENESS_DIFFICULTY`, 403
`SECRET_KEY_REQUIRED`, and 422 `IDEMPOTENCY_KEY_MISMATCH` when an
`Idempotency-Key` is reused with a different body.

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
