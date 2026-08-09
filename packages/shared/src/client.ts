import { toAgentError, type AgentError } from "./errors.js";

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AgentError };

/**
 * Every Xident endpoint wraps its payload: `{ success, data, error, meta }`
 * (api/internal/api/response/response.go). Callers want the payload, not the
 * wrapper — returning the envelope would put `.data` in front of every field an
 * integrator reads, and the docs and golden fixtures describe the inner shape.
 *
 * Detection is on the envelope's own marker (`success` is a boolean AND `data`
 * is present), so a payload that merely happens to have a `data` field is not
 * unwrapped by mistake.
 */
export function unwrapEnvelope(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["success"] === "boolean" && "data" in obj) return obj["data"];
  return parsed;
}

/** Which credential a key string represents. Prefix is authoritative. */
export type KeyKind = "secret" | "public" | "agent" | "unknown";

export function keyKind(key: string): KeyKind {
  if (key.startsWith("sk_")) return "secret";
  if (key.startsWith("pk_")) return "public";
  if (key.startsWith("ak_")) return "agent";
  return "unknown";
}

/** True when the key is a sandbox/test credential rather than a live one. */
export function isSandboxKey(key: string): boolean {
  return key.includes("_test_") || key.includes("_sandbox_");
}

/**
 * Minimal typed HTTP wrapper. Deliberately thin: every authorization decision
 * belongs to the API, so this never inspects scopes or decides what is allowed.
 */
export class XidentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });

      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { message: text }; }
      }

      if (!res.ok) return { ok: false, error: toAgentError(res.status, parsed) };
      return { ok: true, data: unwrapEnvelope(parsed) as T };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        error: {
          error: true,
          status: 0,
          code: aborted ? "TIMEOUT" : "NETWORK_ERROR",
          message: err instanceof Error ? err.message : String(err),
          fix: aborted
            ? "The API did not respond in time. Retry with backoff."
            : "Could not reach the API. Check the base URL and network access.",
          retryable: true,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
