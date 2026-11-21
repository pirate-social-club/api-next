import { Schema } from "effect";
import { fail, reference } from "./identity.mjs";

export const COOKIE_PLAN_SCHEMA = "pirate-staging-cookie-profile-successor-v1";
export const PREVIOUS_GATEWAY =
  "hns-community-app-handle-gateway-sha256:c8cd1fb6f961f3435259bc42e5c8be7022219fb215ea053ebf81107d28cf2b7c";
export const NEXT_GATEWAY =
  "hns-community-app-handle-gateway-sha256:34f51467e42481bf829e774943a63860bf8946f755fb5b73a5727f455c19204c";

const delta = [
  "api_next_source_commit",
  "bundle_sha256",
  "profile_sha256",
  "profile_utf8_bytes",
  "profile_version",
  "solid_ingress_composition_reference",
];
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Hex = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{2})+$/u));
const Generation = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Host = Schema.Struct({ host: Schema.String, state: Schema.Unknown });
export const CookieCensus = Schema.Struct({
  database_time: Schema.String,
  roots: Schema.Array(
    Schema.Struct({
      root: Schema.String,
      rows: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
      apps: Schema.Array(Host),
      handles: Schema.Array(Host),
      recovery: Schema.Unknown,
    }),
  ),
});
const Entry = Schema.Struct({
  root: Schema.Literal("8s28"),
  predecessor: Schema.Unknown,
  predecessor_sha256: Digest,
  successor_id: Digest,
  inherited_health_checked_at: Schema.String,
  health_deadline: Schema.String,
  generations: Schema.Struct({
    dns_activation_generation: Generation,
    app_host_activation_generation: Generation,
    health_generation: Generation,
  }),
  dns_hex: Hex,
  app_hex: Hex,
  health_hex: Hex,
});
const CookiePlan = Schema.Struct({
  schema: Schema.Literal(COOKIE_PLAN_SCHEMA),
  source_commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
  execute_by: Schema.String,
  previous_manifest: Schema.String,
  next_manifest: Schema.String,
  readiness: Schema.Unknown,
  census: CookieCensus,
  census_sha256: Digest,
  entries: Schema.Array(Entry),
});
export function decodeCookiePlan(value: unknown) {
  return Schema.decodeUnknownSync(CookiePlan, { onExcessProperty: "error" })(value);
}
export function decodeCookieCensus(value: unknown) {
  return Schema.decodeUnknownSync(CookieCensus, { onExcessProperty: "error" })(value);
}

/** Exact accepted bytes are the outer boundary. The six-field assertion also
 * documents the intentional change; an extra key or reordered bytes cannot hide
 * behind a permissive staging schema or a profile-version alias. */
export function requireCookieManifestPair(previous: string, next: string) {
  fail(
    new TextEncoder().encode(previous).length <= 65536 &&
      new TextEncoder().encode(next).length <= 65536,
    "Cookie manifest size invalid",
  );
  const before: Record<string, unknown> = JSON.parse(previous);
  const after: Record<string, unknown> = JSON.parse(next);
  fail(
    JSON.stringify(before) === previous && JSON.stringify(after) === next,
    "Cookie manifest is not canonical",
  );
  fail(
    reference(previous) === PREVIOUS_GATEWAY && reference(next) === NEXT_GATEWAY,
    "Cookie manifest is outside the exact accepted transition",
  );
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
  fail(
    JSON.stringify(Object.keys(before)) === JSON.stringify(Object.keys(after)) &&
      JSON.stringify(changed) === JSON.stringify([...delta].sort()) &&
      before.profile_version === "pirate-hns-community-app-interactive-gateway-v3" &&
      after.profile_version === "pirate-hns-community-app-interactive-gateway-v4",
    "Cookie manifest changed an unreviewed field",
  );
  return { before, after };
}
