import type { RuntimeConfig } from "./config.js";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * MCP 2025-11-25 requires a remote server to publish this: it is how a client
 * that knows only the server URL discovers WHICH authorization server to talk
 * to. Without it there is no way for Claude or ChatGPT to start a consent flow
 * against us at all.
 */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation: string;
}

export const SUPPORTED_SCOPES = [
  "verification:read",
  "verification:write",
  "2fa:verify",
  "blacklist:read",
] as const;

export function protectedResourceMetadata(cfg: RuntimeConfig): ProtectedResourceMetadata {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://docs.xident.io/agents",
  };
}

/**
 * The WWW-Authenticate challenge returned with a 401.
 *
 * The `resource_metadata` parameter is the discovery pointer — a client that
 * gets a bare 401 has nowhere to go, whereas this tells it exactly where to
 * look. Including the required scope in an insufficient-scope response lets the
 * client ask for the right thing on the next attempt instead of guessing.
 */
export function challengeHeader(cfg: RuntimeConfig, opts: { error?: string; description?: string; scope?: string } = {}): string {
  const parts = [`Bearer resource_metadata="${cfg.resourceUrl}/.well-known/oauth-protected-resource"`];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.description) parts.push(`error_description="${opts.description}"`);
  if (opts.scope) parts.push(`scope="${opts.scope}"`);
  return parts.join(", ");
}
