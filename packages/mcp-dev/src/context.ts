import { XidentClient, isSandboxKey, keyKind, type KeyKind } from "@xident/mcp-shared";

export const DEFAULT_BASE_URL = "https://api.xident.io";

export interface DevContext {
  /** null when no key is configured — the no-auth tools still work. */
  client: XidentClient | null;
  apiKey: string | null;
  kind: KeyKind | null;
  sandbox: boolean;
  baseUrl: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface EnvLike {
  XIDENT_API_KEY?: string | undefined;
  XIDENT_BASE_URL?: string | undefined;
}

/**
 * Build the run context from the environment.
 *
 * A missing key is NOT an error. Three tools work entirely offline, and making
 * the server refuse to start without credentials would put a setup step between
 * a developer and the first useful answer.
 */
export function contextFromEnv(env: EnvLike, fetchImpl?: typeof fetch): DevContext {
  const baseUrl = env.XIDENT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const apiKey = env.XIDENT_API_KEY?.trim() || null;
  if (!apiKey) {
    return { client: null, apiKey: null, kind: null, sandbox: false, baseUrl, ...(fetchImpl ? { fetchImpl } : {}) };
  }
  return {
    client: new XidentClient({ baseUrl, apiKey, ...(fetchImpl ? { fetchImpl } : {}) }),
    apiKey,
    kind: keyKind(apiKey),
    sandbox: isSandboxKey(apiKey),
    baseUrl,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}
