import { Schema } from "effect";
import { canonicalJson } from "../canonical-json.ts";
import { NationalityPolicy } from "../gates-v2/nationality-policy.ts";
import { sha256Hex } from "../gates-v2/sha256.ts";
import { Sha256Hex } from "../verification/scalars.ts";

const Authoring = Schema.Struct({
  policy_revision: NationalityPolicy.fields.policy_revision,
  evidence_lifetime: NationalityPolicy.fields.evidence_lifetime,
  provider_bindings: NationalityPolicy.fields.provider_bindings,
}).check(Schema.makeFilter((input) => input.evidence_lifetime.kind === "max_age_seconds"));

/** The seller selects an allowlist; lifetime and both bindings remain server-owned. */
export function handleNationalityAuthoringReference(input: unknown): string {
  const authoring = Schema.decodeUnknownSync(Authoring, { onExcessProperty: "error" })(input);
  const [first, second] = authoring.provider_bindings;
  const provider_bindings = first.provider_id === "self.pass" ? [first, second] : [second, first];
  return sha256Hex(
    canonicalJson({
      version: "pirate-handle-nationality-authoring-v1",
      ...authoring,
      provider_bindings,
    }),
  );
}

const Request = Schema.Struct({
  actor_account_id: Schema.NonEmptyString,
  community_id: Schema.NonEmptyString,
  idempotency_key: Schema.NonEmptyString,
  authoring_reference: Sha256Hex,
  requirement: NationalityPolicy.fields.requirement,
});

/** A replay keeps its original server context and immutable normalized requirement. */
export function handleNationalityPolicyAuthoringRequestHash(input: unknown): string {
  const request = Schema.decodeUnknownSync(Request, { onExcessProperty: "error" })(input);
  return sha256Hex(
    canonicalJson({ version: "pirate-handle-nationality-policy-command-v1", ...request }),
  );
}
