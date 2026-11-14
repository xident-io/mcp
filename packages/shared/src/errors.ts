/** An API failure, reshaped into something an agent can act on. */
export interface AgentError {
  error: true;
  status: number;
  code: string;
  message: string;
  fix: string;
  retryable: boolean;
}

const GUIDANCE: Record<string, { fix: string; retryable: boolean }> = {
  ALLOWANCE_EXHAUSTED: {
    fix: "The account's included volume for this period is used up. Buy a prepaid pack, or move to a post-paid tier. A human must do this in billing settings.",
    retryable: false,
  },
  BUDGET_EXCEEDED: {
    fix: "The account reached a monthly spend budget its owner set. Raise or remove it in billing settings. A human must do this.",
    retryable: false,
  },
  INSUFFICIENT_SCOPE: {
    fix: "This credential is not authorized for this operation. Scopes are granted when the key is created or the client is authorized; they cannot be widened at call time.",
    retryable: false,
  },
  TENANT_SUSPENDED: {
    fix: "The account is suspended, usually for non-payment. A human must resolve it in billing settings.",
    retryable: false,
  },
  SECRET_KEY_REQUIRED: {
    fix: "Creating a session needs a server key (sk_live_, sk_test_, ak_live_ or ak_test_). A public key (pk_) cannot create one. Configure a server key; never put it in a browser or a mobile app.",
    retryable: false,
  },
  MISSING_CALLBACK_URL: {
    fix: "Send callback_url: the HTTPS address (or http://localhost in development) the widget returns the person to.",
    retryable: false,
  },
  MISSING_USER_ID: {
    fix: "Send user_id: your own identifier for the person being verified. It comes back on the callback and in the result.",
    retryable: false,
  },
  INVALID_PURPOSE: {
    fix: "Send purpose as age_verification (the default) or id_verification, or leave it out.",
    retryable: false,
  },
  INVALID_MIN_AGE: {
    fix: "For age_verification send min_age as a whole number from 12 to 25 (it is rounded up to the next of 12, 15, 18, 21 or 25). For id_verification leave min_age out, or send 0.",
    retryable: false,
  },
  INVALID_ACCESS_CHECK: {
    fix: "Send expected_user_id (the user your backend started the verification for) and required_min_age (a whole number from 12 to 25) together, or leave both out.",
    retryable: false,
  },
  INVALID_VERIFICATION_MODE: {
    fix: "Use auto, document or facial. An id_verification cannot use facial: leave verification_mode out, or send document.",
    retryable: false,
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    fix: "This idempotency key was already used with different settings. Use a new key for a different request; reuse a key only to retry the identical request.",
    retryable: false,
  },
};

function defaultGuidance(status: number): { fix: string; retryable: boolean } {
  if (status === 401) return { fix: "The API key was missing, malformed, or revoked. Check the configured credential.", retryable: false };
  if (status === 403) return { fix: "The credential is valid but not permitted to do this.", retryable: false };
  if (status === 404) return { fix: "No such resource. Check the identifier — tokens are single-tenant and expire.", retryable: false };
  if (status === 429) return { fix: "Rate limited. Back off and retry after the interval in the Retry-After header.", retryable: true };
  if (status >= 500) return { fix: "Server-side failure. Retry with exponential backoff; if it persists, contact support.", retryable: true };
  return { fix: "The request was rejected. Check the request body against the endpoint schema.", retryable: false };
}

/**
 * Turn an API error response into a structured object.
 * Deliberately never returns bare prose: an agent must receive data it reports,
 * not text it might interpret as direction.
 */
export function toAgentError(status: number, body: unknown): AgentError {
  const obj = (body ?? {}) as Record<string, unknown>;
  const nested = (obj["error"] ?? {}) as Record<string, unknown>;
  const code = String(obj["code"] ?? nested["code"] ?? `HTTP_${status}`);
  const message = String(obj["message"] ?? nested["message"] ?? obj["error"] ?? "Request failed");
  const guidance = GUIDANCE[code] ?? defaultGuidance(status);
  return { error: true, status, code, message, fix: guidance.fix, retryable: guidance.retryable };
}
