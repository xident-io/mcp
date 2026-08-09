import type { RuntimeConfig } from "./config.js";

/** What a presented bearer token turned out to be. */
export type AuthResult =
  | { ok: true; scopes: string[]; unrestricted: boolean }
  | { ok: false; status: 401 | 403; error: string; description: string };

/**
 * Resolve a bearer token's capabilities by asking the API.
 *
 * The resource server deliberately does NOT validate tokens itself. It holds no
 * signing key and no database; the API is the single authority on whether a
 * credential is live and what it may do. Duplicating that logic here would
 * create a second place for revocation to be missed.
 */
export async function resolveToken(
  cfg: RuntimeConfig,
  bearer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.apiBaseUrl}/verify/v1/token-info`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
    });
  } catch {
    return { ok: false, status: 401, error: "server_error", description: "could not reach the authorization API" };
  }

  if (res.status === 401) {
    return { ok: false, status: 401, error: "invalid_token", description: "the access token is invalid, expired, or revoked" };
  }
  if (!res.ok) {
    return { ok: false, status: 403, error: "insufficient_scope", description: "this credential cannot be used here" };
  }

  const body = (await res.json()) as { data?: { scopes?: string[]; unrestricted?: boolean } };
  const scopes = body.data?.scopes ?? [];
  const unrestricted = body.data?.unrestricted ?? false;
  return { ok: true, scopes, unrestricted };
}

/** Extract a bearer token from an Authorization header. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * The scopes to build a tool list from.
 *
 * An unrestricted credential (a plain sk_) gets every runtime tool, matching
 * what the API would actually permit. Returning an empty list for it would hide
 * tools the caller is entitled to use.
 */
export function effectiveScopes(result: Extract<AuthResult, { ok: true }>, all: readonly string[]): string[] {
  return result.unrestricted ? [...all] : result.scopes;
}
