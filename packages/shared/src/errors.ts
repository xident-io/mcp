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
