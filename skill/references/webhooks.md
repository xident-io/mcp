# Xident webhooks

## Envelope

```json
{ "event": "verification.completed", "timestamp": "2026-08-09T10:00:00Z", "data": { /* identical to the result payload */ } }
```

`data` is byte-identical to what `GET /verify/v1/result/{token}` returns, so one
parser handles both.

## Signature

Header: `X-Xident-Signature: t=<unix-seconds>,v1=<hex>`

Signed string: `<t>.<raw-body>` — HMAC-SHA256 with your webhook secret, hex.

## The rule that breaks most integrations

**Verify against the raw bytes.** Frameworks that hand you a parsed object have
already discarded the original byte order and whitespace. Re-serializing gives
different bytes and a different HMAC.

- Express: `express.raw({ type: "application/json" })` on the webhook route
- FastAPI: `await request.body()`
- Laravel: `$request->getContent()`
- Go: read `r.Body` before decoding
- Rails: `request.raw_post`

## Node

```js
import crypto from "node:crypto";

export function verifyXidentWebhook(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return false;

  const age = Math.floor(Date.now() / 1000) - Number(parts.t);
  if (Math.abs(age) > toleranceSeconds) return false;

  const expected = crypto.createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

## Python

```python
import hashlib, hmac, time

def verify_xident_webhook(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False
    if abs(int(time.time()) - int(t)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1.lower())
```

## PHP

```php
function verify_xident_webhook(string $rawBody, string $header, string $secret, int $tolerance = 300): bool {
    $parts = [];
    foreach (explode(',', $header) as $p) {
        [$k, $v] = array_pad(explode('=', $p, 2), 2, null);
        $parts[trim($k)] = trim((string) $v);
    }
    if (empty($parts['t']) || empty($parts['v1'])) return false;
    if (abs(time() - (int) $parts['t']) > $tolerance) return false;
    $expected = hash_hmac('sha256', $parts['t'] . '.' . $rawBody, $secret);
    return hash_equals($expected, strtolower($parts['v1']));
}
```

## Responding

Return `2xx` quickly. Do the work asynchronously. A non-2xx is retried with
backoff, so handlers must be idempotent — key on `data.token`.

## Replay protection

Reject signatures outside the tolerance window (300s is typical) and record
tokens you have already processed.
