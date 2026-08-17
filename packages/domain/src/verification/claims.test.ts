import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Assurance,
  CANONICAL_CLAIM_CATALOG,
  CanonicalClaimIdentifier,
  ClaimCatalogEntry,
  NamedIssuerActionScope,
  NamedIssuerScope,
  NoSubjectScope,
  PresentationKind,
  ProofProviderManifest,
  SubjectKeyScopeSemantics,
} from "./claims";

describe("verification claim catalog", () => {
  test("keeps document subject uniqueness distinct from holder liveness", () => {
    const unique = CANONICAL_CLAIM_CATALOG.find((entry) => entry.id === "human.unique");
    const credential = CANONICAL_CLAIM_CATALOG.find(
      (entry) => entry.id === "credential.subject_unique",
    );
    const live = CANONICAL_CLAIM_CATALOG.find((entry) => entry.id === "human.live");
    const holderBound = CANONICAL_CLAIM_CATALOG.find(
      (entry) => entry.id === "document.holder_bound",
    );

    expect(unique?.id).not.toBe(credential?.id);
    expect(credential?.holder_liveness).toBe("not_implied");
    expect(live?.holder_liveness).toBe("required");
    expect(holderBound).toMatchObject({
      category: "document",
      holder_liveness: "not_implied",
    });
    expect(holderBound?.id).not.toBe(live?.id);
    expect(credential?.scope_requirement).toBe("named_issuer_scope");
  });

  test("decodes every catalog entry and rejects unknown claim identifiers", () => {
    for (const entry of CANONICAL_CLAIM_CATALOG) {
      expect(Schema.decodeUnknownSync(ClaimCatalogEntry)(entry)).toEqual(entry);
    }
    expect(() =>
      Schema.decodeUnknownSync(CanonicalClaimIdentifier)("provider.unique_human"),
    ).toThrow();
  });

  test("requires rp_scope for a uniqueness scope", () => {
    expect(
      Schema.decodeUnknownSync(NamedIssuerScope)({
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "zkpassport",
        rp_scope: "pirate.example",
      }),
    ).toMatchObject({ rp_scope: "pirate.example" });

    expect(() =>
      Schema.decodeUnknownSync(NamedIssuerScope)({
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "zkpassport",
        rp_scope: "",
      }),
    ).toThrow();
  });

  test("keeps an action namespace structurally distinct from an RP scope", () => {
    const actionScope = Schema.decodeUnknownSync(NamedIssuerActionScope)({
      kind: "named",
      scope_semantics: "issuer_rp_action_scope",
      issuer: "proof-provider",
      rp_scope: "pirate.example",
      action_scope: "campaign-2026",
    });
    expect(actionScope.action_scope).toBe("campaign-2026");
    expect(() =>
      Schema.decodeUnknownSync(NamedIssuerActionScope)({
        kind: "named",
        scope_semantics: "issuer_rp_action_scope",
        issuer: "proof-provider",
        rp_scope: "pirate.example",
      }),
    ).toThrow();
  });

  test("proof manifests accept provider data without a provider enum", () => {
    const manifest = Schema.decodeUnknownSync(ProofProviderManifest)({
      provider_id: "future-provider",
      manifest_version: "1",
      operation_deadlines: {
        plan_ms: 1_000,
        start_ms: 1_000,
        complete_ms: 1_000,
        callback_ms: 1_000,
      },
      callback_mode: "none",
      callback_header_allowlist: [],
      protocol_versions: ["proof-v1"],
      environments: ["production"],
      supported_methods: ["document"],
      claim_ids: ["credential.subject_unique"],
      claim_capabilities: [
        { claim_id: "credential.subject_unique", request_modes: ["curated", "dynamic"] },
      ],
      presentation_kinds: ["embedded_sdk", "none"],
      assurance_levels: ["document_zk"],
      subject_key_scope_semantics: "issuer_rp_scope",
    });
    expect(manifest.provider_id).toBe("future-provider");
    expect(manifest.presentation_kinds).toEqual(["embedded_sdk", "none"]);
    expect(manifest.claim_capabilities[0]?.request_modes).toEqual(["curated", "dynamic"]);
    expect(manifest.subject_key_scope_semantics).toBe("issuer_rp_scope");
    expect(() =>
      Schema.decodeUnknownSync(ProofProviderManifest)({
        ...manifest,
        subject_key_scope_semantics: "unknown_scope",
      }),
    ).toThrow();
  });

  test("models the complete subject-key scope vocabulary", () => {
    for (const semantics of ["issuer_rp_scope", "issuer_rp_action_scope", "none"] as const) {
      expect(Schema.decodeUnknownSync(SubjectKeyScopeSemantics)(semantics)).toBe(semantics);
    }
    expect(() => Schema.decodeUnknownSync(SubjectKeyScopeSemantics)("unknown_scope")).toThrow();
    for (const presentation of ["redirect", "deeplink", "embedded_sdk", "poll", "none"] as const) {
      expect(Schema.decodeUnknownSync(PresentationKind)(presentation)).toBe(presentation);
    }
  });

  test("models no-subject proof scope explicitly", () => {
    expect(
      Schema.decodeUnknownSync(NoSubjectScope)({ kind: "none", issuer: "provider-no-subject" }),
    ).toEqual({ kind: "none", issuer: "provider-no-subject" });
    expect(() =>
      Schema.decodeUnknownSync(NoSubjectScope)({
        kind: "unknown_scope",
        issuer: "provider-no-subject",
      }),
    ).toThrow();
  });

  test("keeps assurance provider-neutral", () => {
    expect(Schema.decodeUnknownSync(Assurance)("document_zk")).toBe("document_zk");
    expect(() => Schema.decodeUnknownSync(Assurance)("very")).toThrow();
  });
});
