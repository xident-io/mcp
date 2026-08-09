/** Runtime server configuration, resolved once at startup. */
export interface RuntimeConfig {
  /** This server's canonical URI. Tokens are bound to it (RFC 8707). */
  resourceUrl: string;
  /** The Xident API origin. */
  apiBaseUrl: string;
  /** The authorization server's issuer. */
  issuer: string;
  port: number;
}

export const DEFAULTS = {
  resourceUrl: "https://mcp.xident.io",
  apiBaseUrl: "https://api.xident.io",
  issuer: "https://api.xident.io/agent",
  port: 8080,
} as const;

export interface EnvLike {
  XIDENT_MCP_RESOURCE_URL?: string | undefined;
  XIDENT_API_BASE_URL?: string | undefined;
  XIDENT_ISSUER?: string | undefined;
  PORT?: string | undefined;
}

export function configFromEnv(env: EnvLike): RuntimeConfig {
  const port = Number(env.PORT ?? DEFAULTS.port);
  return {
    resourceUrl: trimSlash(env.XIDENT_MCP_RESOURCE_URL ?? DEFAULTS.resourceUrl),
    apiBaseUrl: trimSlash(env.XIDENT_API_BASE_URL ?? DEFAULTS.apiBaseUrl),
    issuer: trimSlash(env.XIDENT_ISSUER ?? DEFAULTS.issuer),
    port: Number.isFinite(port) && port > 0 ? port : DEFAULTS.port,
  };
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
