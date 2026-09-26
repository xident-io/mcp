import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The spec in packages/shared/spec/openapi.json ships inside the public npm
// package @xident/mcp-shared and is read by the xident_* tools, so it must
// carry no internal note and no hint about how the checks work. This is the
// same guard as xident-io/docs tests/unit/public-text-guard.ts (keep them identical).

/**
 * Patterns that only internal notes and security hints produce, matched
 * against every description and summary of the public API reference. Kept
 * broad on purpose: a false alarm costs one rewording, a leak publishes how
 * the checks work (and how the widget measures head pose, which a scripted
 * client would copy). The same list guards xident-io/docs public/openapi.json
 * and the spec bundled in the mcp npm packages.
 */

// Tables created by the api migrations (xident-io/api migrations/*.sql, read
// 2026-09-26) whose names contain an underscore and are not also the name of
// a public field or parameter.
const TABLES = [
  'account_audit_logs',
  'account_connections',
  'account_id_verifications',
  'account_login_history',
  'account_notifications',
  'account_passkeys',
  'account_sessions',
  'account_social_identities',
  'account_verified_ages',
  'account_webauthn_sessions',
  'admin_audit_logs',
  'admin_passkeys',
  'admin_role_permissions',
  'admin_roles',
  'admin_users',
  'admin_webauthn_sessions',
  'analytics_report_posts',
  'api_keys',
  'api_keys_allowed_countries',
  'api_request_logs',
  'api_versions',
  'billing_alerts',
  'billing_periods',
  'content_categories',
  'countries_allowed_methods',
  'countries_rules_regimes',
  'country_content_rules',
  'country_document_types',
  'credit_ledger',
  'data_processing_agreements',
  'document_phashes',
  'email_send_events',
  'face_2fa_challenges',
  'face_2fa_enrollments',
  'face_blacklist_entries',
  'handoff_tokens',
  'issuer_reputation_outcomes',
  'issuer_reputation_stats',
  'marketing_campaigns',
  'marketing_emails',
  'marketing_events',
  'marketing_leads',
  'marketing_links',
  'marketing_suppressions',
  'marketing_templates',
  'member_audit_logs',
  'member_passkeys',
  'member_social_identities',
  'member_webauthn_sessions',
  'notification_reads',
  'oauth_agent_access_tokens',
  'oauth_agent_auth_codes',
  'oauth_agent_clients',
  'oauth_agent_grants',
  'oauth_agent_refresh_tokens',
  'oauth_authorization_codes',
  'oauth_clients',
  'oauth_consent_grants',
  'oauth_refresh_tokens',
  'oauth_signing_keys',
  'ocr_model_routes',
  'ocr_provider_usage',
  'pack_purchases',
  'pricing_tiers',
  'promo_codes',
  'promo_redemptions',
  'regime_methods',
  'review_queue_items',
  'session_face_embeddings',
  'setting_definitions',
  'support_knowledge_base',
  'support_tickets',
  'survey_aggregations',
  'survey_responses',
  'tenant_billing_settings',
  'tenant_settings',
  'ticket_messages',
  'usage_credit_grants',
  'usage_daily',
  'usage_events',
  'verification_age_scores',
  'verification_sessions',
  'verification_tokens',
  'vlm_call_logs',
  'vlm_provider_models',
  'vlm_providers',
  'waiting_list_entries',
  'webhook_deliveries',
];

const PATTERNS: Array<[string, RegExp]> = [
  ['soft mode', /soft mode/i],
  ['CAPTUREGUARD', /CAPTUREGUARD/i],
  ['iteration oracle', /iteration oracle/i],
  ['image-quality gate', /image-quality gate/i],
  ['replay', /\breplay(?:s|ed|ing)?\b/i],
  ['sensor noise', /sensor[- ]noise/i],
  ['plan file', /plans\//],
  ['internal route', /\/admin\/v1|\/dashboard\/v1|\/api\/v1/],
  ['table name', new RegExp('\\b(?:' + TABLES.join('|') + ')\\b')],
  ['source file', /\.(?:go|tsx?)\b/],
  ['Go package path', /\b(?:pkg|internal|cmd)\/[a-z]/],
  ['Go call', /\b(?:[a-z][a-z0-9]*[A-Z]|[A-Z][a-z0-9]+[A-Z])[A-Za-z0-9]*\(/],
  ['qualified Go name', /\b(?:[a-z][a-z0-9]*|[A-Z][a-z0-9]+[A-Za-z0-9]*)\.[A-Z][A-Za-z0-9]*\b/],
  ['Go test name', /\bTest[A-Z][A-Za-z0-9]+\b/],
  ['Go constant name', /\b(?:Kind|Err)[A-Z][a-z]+[A-Za-z0-9]*\b/],
  ['comparison operator', />=|<=|==|!=/],
  ['route parameter', /\/:[a-z_]+/],
  ['internal word', /\bSEC-\d+|\bshannon\b|\bwave \d|\bworkers?\b|\bredis\b|\bgoldens?\b|\bskills?\b|\bfreeze\b|\bmiddleware\b|\bomitempty\b|\bgo-playground\b|risk-score effect|safe to expose|\bformulas?\b|\bEMA\b|\blandmarks?\b|\bmediapipe\b|\bcalibration\b|\b[xy](?:1|33|263)\b/i],
  ['internal path letter', /\bPath [A-E]\b/],
];

const pascal = (name: string) =>
  name
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

/**
 * The reasons a text is an internal note. prop is the property name when the
 * text describes a schema property: a description that opens with the
 * property's own Go name ("ExpectedRef is ...", "MismatchPolicy: ...") or
 * spells a multi-word property the Go way ("TsMs") is a Go doc comment that
 * was published by mistake.
 */
function internalMarkers(text: string, prop?: string): string[] {
  const hits = PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (prop) {
    const first = text.split(/[ :]/, 1)[0] ?? '';
    if (
      first.toLowerCase() === prop.replace(/_/g, '').toLowerCase() &&
      /^\S+(?::| (?:is|are|carries|mirrors|reports|overrides)\b)/.test(text)
    ) {
      hits.push('Go doc comment');
    }
    if (prop.includes('_') && text.includes(pascal(prop))) hits.push('Go field name');
  }
  return hits;
}

interface PublicText {
  where: string;
  text: string;
  prop?: string;
}

/** Every description and summary in a spec, with where it is. */
function publicTexts(spec: unknown): PublicText[] {
  const out: PublicText[] = [];
  const walk = (node: unknown, where: string, prop?: string) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, where + '[' + i + ']'));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if ((k === 'description' || k === 'summary') && typeof v === 'string') {
          out.push(prop ? { where: where + '/' + k, text: v, prop } : { where: where + '/' + k, text: v });
        } else if (k === 'properties' && v && typeof v === 'object') {
          for (const [pn, pv] of Object.entries(v)) walk(pv, where + '/properties/' + pn, pn);
        } else walk(v, where + '/' + k);
      }
    }
  };
  walk(spec, '');
  return out;
}

const specPath = join(dirname(fileURLToPath(import.meta.url)), "..", "spec", "openapi.json");

describe("the bundled spec's public text", () => {
  it("carries no internal note or security hint", () => {
    const texts = publicTexts(JSON.parse(readFileSync(specPath, "utf8")));
    expect(texts.length).toBeGreaterThan(300);
    const found = texts
      .map((t) => ({ ...t, hits: internalMarkers(t.text, t.prop) }))
      .filter((t) => t.hits.length > 0)
      .map((t) => t.where + ": " + t.hits.join(", "));
    expect(found).toEqual([]);
  });

  it("catches the kinds of text that were published before", () => {
    const leaks: Array<[string, string?]> = [
      ["soft mode applies unless CAPTUREGUARD_REQUIRE_PROOF is set"],
      ["a precise score on the wire is an iteration oracle for fraudsters"],
      ["the widget currently applies no image-quality gate at all"],
      ["the frame-level forensic checks all pass on a replayed recording"],
      ["Sensor-noise consistency needs fine detail"],
      ["see plans/document-data-match.md"],
      ["Returns an empty list, account_connections table dropped"],
      ["Three route groups: /api/v1, /dashboard/v1, /admin/v1"],
      ["ExpectedRef is the opaque one-time reference", "expected_ref"],
      ["MismatchPolicy: report or review", "mismatch_policy"],
      ["Gyro/Light/Visibility events use TsMs", "ts_ms"],
      ["Visibility fields (KindVisibility)."],
      ["(== SnapToBracket(min_age) for a legitimate widget)"],
      ["see services.MaskSubjectReason"],
      ["creates a Redis session"],
      ["yaw = -50 × (dL - dR) / (dL + dR), where dL = x1 - x33"],
      ["smoothed with an EMA of 0.55"],
    ];
    for (const [text, prop] of leaks) expect(internalMarkers(text, prop), text).not.toEqual([]);
    for (const text of ["Starts a discoverable credential (WebAuthn) ceremony", "Returns the verification verdict for a session"]) {
      expect(internalMarkers(text), text).toEqual([]);
    }
  });
});
