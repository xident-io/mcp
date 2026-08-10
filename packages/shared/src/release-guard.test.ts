import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Fails a release whose git tag disagrees with what would actually be published.
 *
 * Same guard the four SDK repos carry, adapted to a workspace: `pnpm publish -r`
 * ships THREE manifests, so a tag matching one of them and not the others is a
 * real and silent failure mode. Checking only this package would let a stale
 * @xident/mcp-dev go out under a tag that looks correct.
 *
 * npm versions are immutable, so the recovery for publishing 0.1.0 under a
 * v0.2.0 tag is a version bump, not a fix — which is why this runs BEFORE
 * `pnpm publish` rather than as a post-release check.
 *
 * The tag is INJECTED via the environment rather than read from git —
 * .github/workflows/publish.yml hands it over as XIDENT_RELEASE_VERSION
 * (github.ref_name needs no git history, so the default shallow checkout is
 * enough; a `git describe` here would fail in CI and pass on a laptop).
 * Outside a release the variable is unset and there is no tag to compare
 * against, so the guard skips rather than failing every `pnpm test`.
 */
const MANIFESTS = [
  "../shared/package.json",
  "../mcp-dev/package.json",
  "../mcp/package.json",
] as const;

describe("release version guard", () => {
  const tag = process.env["XIDENT_RELEASE_VERSION"];

  it.skipIf(!tag)("every published package version matches the release tag", () => {
    const want = (tag as string).replace(/^v/, "");
    const actual = MANIFESTS.map((m) => {
      const pkg = JSON.parse(readFileSync(m, "utf8")) as { name: string; version: string };
      return [pkg.name, pkg.version] as const;
    });
    expect(Object.fromEntries(actual)).toEqual(
      Object.fromEntries(actual.map(([name]) => [name, want])),
    );
  });
});
