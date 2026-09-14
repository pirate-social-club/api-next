import { Schema } from "effect";
import { canonicalJson } from "../canonical-json.ts";
import {
  NamedIssuerActionScope,
  NamedIssuerScope,
  ProviderConfigurationRef,
} from "../verification/claims.ts";
import { sha256Hex } from "./sha256.ts";

export const DocumentProviderBinding = Schema.Struct({
  provider_id: Schema.Literals(["self.pass", "zkpassport"]),
  provider_configuration: ProviderConfigurationRef,
  method: Schema.Literal("document"),
  protocol_version: Schema.NonEmptyString,
  scope: Schema.Union([NamedIssuerScope, NamedIssuerActionScope]),
  environment: Schema.NonEmptyString,
}).check(
  Schema.makeFilter((binding) =>
    binding.provider_configuration.kind === "dynamic" &&
    binding.scope.issuer === binding.provider_id &&
    binding.protocol_version ===
      (binding.provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2")
      ? undefined
      : "Expected the accepted document provider protocol and issuer binding",
  ),
);

export const DocumentProviderAlternatives = Schema.Tuple([
  DocumentProviderBinding,
  DocumentProviderBinding,
]).check(
  Schema.makeFilter((bindings) =>
    new Set(bindings.map((binding) => binding.provider_id)).size === 2
      ? undefined
      : "Expected both Self and ZKPassport alternatives",
  ),
);

export type DocumentProviderBinding = Schema.Schema.Type<typeof DocumentProviderBinding>;

/** Provider identity is separate from the claim being requested. */
export function documentProviderBindingHash(binding: DocumentProviderBinding): string {
  return sha256Hex(canonicalJson({ binding, version: "document-provider-binding-v1" }));
}
