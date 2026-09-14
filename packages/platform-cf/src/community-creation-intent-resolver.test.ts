import { describe, expect, test } from "bun:test";
import type {
  ControlPlaneError,
  ControlPlaneStatement,
  ControlPlaneTransaction,
} from "@pirate/application";
import { VerificationStartStorageFailed } from "@pirate/application/verification";
import {
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  nationalityProviderBindingHash,
} from "@pirate/domain";
import { Effect } from "effect";
import {
  type CommunityCreationIntentResolverRuntime,
  makeCommunityCreationIntentResolver,
} from "./community-creation-intent-resolver.ts";
import { compileOptionalRouteDraft } from "./community-creation-repository.ts";

const providerBindingHash = communityCreationProviderBindingHash({
  requirement: "human_identity",
  family: null,
  provider_id: "very.web",
  provider_configuration: { kind: "dynamic", reference: "very-web", version: "1" },
  protocol_version: "very-web-v1",
});
const creationInput = {
  actor_id: "user-1",
  provider_id: "very.web",
  creation_intent_id: "intent-1",
  ceremony_intent_id: "ceremony-1",
  requirement: "human_identity" as const,
  generation: 1,
  expected_revision: 1,
  idempotency_key: "start-1",
};
const boundRow = {
  intent_id: "intent-1",
  actor_id: "user-1",
  revision: "1",
  status: "verification_required",
  creation_contract_version: "route_v1",
  requirement_kind: "human_identity",
  requirement_status: "pending",
  requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  provider_id: "very.web",
  provider_binding_hash: providerBindingHash,
  provider_configuration_kind: "dynamic",
  provider_configuration_ref: "very-web",
  provider_configuration_version: "1",
  generation: "1",
  current_ceremony_intent_id: "ceremony-1",
  route_family: null,
  route_root_label: null,
  route_root_label_display: null,
  route_path_segment: null,
  ceremony_intent_id: "ceremony-1",
  ceremony_requirement_kind: "human_identity",
  ceremony_generation: "1",
  ceremony_requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
  ceremony_provider_id: "very.web",
  ceremony_provider_binding_hash: providerBindingHash,
  ceremony_provider_configuration_kind: "dynamic",
  ceremony_provider_configuration_ref: "very-web",
  ceremony_provider_configuration_version: "1",
  ceremony_route_family: null,
  ceremony_route_root_label: null,
  ceremony_route_root_label_display: null,
  ceremony_route_path_segment: null,
  reservation_request_hash: communityCreationCeremonyReservationHash({
    actor_id: "user-1",
    creation_intent_id: "intent-1",
    ceremony_intent_id: "ceremony-1",
    requirement: "human_identity",
    generation: 1,
    requirement_hash: HUMAN_MEMBERSHIP_VERIFICATION_REQUIREMENT_HASH,
    provider_id: "very.web",
    provider_binding_hash: providerBindingHash,
    route: null,
  }),
  intent_active: true,
  ceremony_active: true,
};

const composedPolicy = {
  version: 1,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and",
      requirements: [
        { requirement: "human-verification" },
        { requirement: "nationality-allowed", allowedCountries: ["us", "US"] },
      ],
    },
  ],
};

const authoring = {
  policy_revision: 1,
  evidence_lifetime: { kind: "max_age_seconds", seconds: 3600 },
  provider_bindings: ["self.pass", "zkpassport"].map((provider_id) => ({
    provider_id,
    provider_configuration: { kind: "dynamic", reference: `test:${provider_id}`, version: "1" },
    method: "document",
    protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
    scope: {
      kind: "named",
      scope_semantics: "issuer_rp_scope",
      issuer: provider_id,
      rp_scope: "test",
    },
    environment: "test",
  })),
};

const compiledNationality = (() => {
  const draft = compileOptionalRouteDraft(composedPolicy, authoring)?.nationality;
  if (draft === undefined) throw new Error("nationality fixture did not compile");
  return draft;
})();
const selfBinding = compiledNationality.providerBindings[0];
const zkBinding = compiledNationality.providerBindings[1];
const selfBindingHash = nationalityProviderBindingHash(selfBinding);
const zkBindingHash = nationalityProviderBindingHash(zkBinding);

function nationalityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ceremony_intent_id: "ceremony-1",
    actor_id: "user-1",
    intent_id: "intent-1",
    generation: "1",
    requirement_hash: compiledNationality.requirementHash,
    provider_id: "self.pass",
    provider_binding_hash: selfBindingHash,
    state_actor_id: "user-1",
    state_status: "pending",
    state_generation: "1",
    state_requirement_hash: compiledNationality.requirementHash,
    current_ceremony_intent_id: "ceremony-1",
    intent_status: "verification_required",
    intent_actor_id: "user-1",
    intent_draft: { policy: composedPolicy },
    creation_contract_version: "optional_route_v2",
    intent_active: true,
    ...overrides,
  };
}

function transactionWith(
  rowsByLabel: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  statements: ControlPlaneStatement[] = [],
): ControlPlaneTransaction {
  return {
    execute: <Row>(statement: ControlPlaneStatement) => {
      statements.push(statement);
      const rows = rowsByLabel[statement.label] ?? [];
      return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
    },
  };
}

function runtimeFor(
  rowsByLabel: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  statements: ControlPlaneStatement[] = [],
): CommunityCreationIntentResolverRuntime {
  return {
    withTransaction: <A>(
      use: (
        transaction: ControlPlaneTransaction,
      ) => Effect.Effect<A, ControlPlaneError | VerificationStartStorageFailed>,
    ) =>
      use(transactionWith(rowsByLabel, statements)).pipe(
        Effect.mapError(() => new VerificationStartStorageFailed()),
      ),
  };
}

function resolverWith(
  rowsByLabel: Readonly<Record<string, readonly Record<string, unknown>[]>>,
  environment = "test",
) {
  const statements: ControlPlaneStatement[] = [];
  const resolver = makeCommunityCreationIntentResolver(
    runtimeFor(rowsByLabel, statements),
    environment,
  );
  return { resolver, statements };
}

const nationalityInput = {
  actor_id: "user-1",
  intent_id: "ceremony-1",
  provider_id: "self.pass",
};

function nationalityRuntime(
  options: Readonly<{ readonly providerState?: string; readonly attemptProvider?: string }> = {},
) {
  const statements: ControlPlaneStatement[] = [];
  const resolver = makeCommunityCreationIntentResolver(
    {
      withTransaction: <A>(
        use: (
          transaction: ControlPlaneTransaction,
        ) => Effect.Effect<A, ControlPlaneError | VerificationStartStorageFailed>,
      ) =>
        use(
          transactionWith(
            {
              "community.creation.resolve-nationality-intent": [nationalityRow()],
              "nationality.ceremony.state.ensure": [],
              "nationality.ceremony.state.lock": [
                {
                  actor_id: "user-1",
                  status: options.providerState ?? "pending",
                  requirement_hash: compiledNationality.requirementHash,
                  accepted_provider_ids: ["self.pass", "zkpassport"],
                  generation: "1",
                  current_provider_id: options.attemptProvider ?? "self.pass",
                },
              ],
              "nationality.ceremony.attempt.current": [
                {
                  ceremony_intent_id: "ceremony-1",
                  provider_id: options.attemptProvider ?? "self.pass",
                  generation: "1",
                },
              ],
            },
            statements,
          ),
        ).pipe(Effect.mapError(() => new VerificationStartStorageFailed())),
    },
    "test",
    {
      nationality_authoring: authoring,
      nationality_ceremony_ttl_seconds: 600,
      next_ceremony_intent_id: () => "ceremony-next",
    },
  );
  return { resolver, statements };
}

describe("community creation verification intent resolver", () => {
  test("returns the exact canonical Very palm plan for the persisted actor/intent binding", async () => {
    const { resolver, statements } = resolverWith({
      "community.creation.resolve-verification-intent": [boundRow],
    });
    await expect(Effect.runPromise(resolver.resolve(creationInput))).resolves.toEqual({
      method: "palm_web",
      scope: {
        kind: "named",
        scope_semantics: "issuer_rp_scope",
        issuer: "https://verify.very.org",
        rp_scope: "pirate-social",
      },
      requested_requirements: [
        { claim_id: "credential.subject_unique" },
        { claim_id: "human.personhood" },
      ],
      requested_claim_ids: ["credential.subject_unique", "human.personhood"],
      subject_binding_intent: "establish",
      protocol_version: "very-web-v1",
      environment: "test",
      verification_purpose: {
        intent: "community_creation",
      },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      label: "community.creation.resolve-verification-intent",
      values: ["intent-1", "user-1", "ceremony-1"],
      readonly: false,
    });
  });

  test("fails closed without exposing whether another actor owns the intent", async () => {
    for (const rows of [
      [],
      [{ ...boundRow, actor_id: "another-user" }],
      [{ ...boundRow, status: "commit_ready" }],
      [{ ...boundRow, intent_active: false }],
      [{ ...boundRow, provider_id: "self.pass" }],
      [{ ...boundRow, requirement_hash: "0".repeat(64) }],
      [{ ...boundRow, provider_configuration_version: "2" }],
    ]) {
      const { resolver } = resolverWith({
        "community.creation.resolve-verification-intent": rows,
      });
      await expect(Effect.runPromise(resolver.resolve(creationInput))).resolves.toBeNull();
    }
  });

  test("rejects ambiguous storage and invalid environment configuration", async () => {
    const ambiguous = resolverWith({
      "community.creation.resolve-verification-intent": [boundRow, boundRow],
    }).resolver;
    await expect(Effect.runPromise(ambiguous.resolve(creationInput))).rejects.toBeInstanceOf(
      VerificationStartStorageFailed,
    );

    const invalid = makeCommunityCreationIntentResolver(
      {
        withTransaction: () => Effect.fail(new VerificationStartStorageFailed()),
      },
      " test ",
    );
    await expect(Effect.runPromise(invalid.resolve(creationInput))).rejects.toBeInstanceOf(
      VerificationStartStorageFailed,
    );
  });

  test("returns the parsed plan for an unstarted nationality draft", async () => {
    const { resolver } = nationalityRuntime();
    await expect(Effect.runPromise(resolver.resolve(nationalityInput))).resolves.toEqual(
      expect.objectContaining({
        method: "document",
        subject_binding_intent: "establish",
        protocol_version: "self-pass-v1",
        environment: "test",
        requested_claim_ids: ["nationality.allowed"],
        verification_purpose: { intent: "community_creation" },
      }),
    );
  });

  test("replays the bound provider without advancing the generation", async () => {
    const { resolver, statements } = nationalityRuntime({
      attemptProvider: "zkpassport",
    });
    await expect(
      Effect.runPromise(resolver.resolve({ ...nationalityInput, provider_id: "zkpassport" })),
    ).resolves.toEqual(
      expect.objectContaining({
        protocol_version: "zkpassport-v2",
        requested_requirements: [{ claim_id: "nationality.allowed", allowed_countries: ["US"] }],
      }),
    );
    expect(
      statements.some((statement) => statement.label === "nationality.ceremony.attempt.insert"),
    ).toBe(false);
  });

  test("advances the generation once when the provider switches", async () => {
    const { resolver, statements } = nationalityRuntime({
      attemptProvider: "self.pass",
    });
    await expect(
      Effect.runPromise(resolver.resolve({ ...nationalityInput, provider_id: "zkpassport" })),
    ).resolves.toEqual(expect.objectContaining({ protocol_version: "zkpassport-v2" }));
    const inserted = statements.find(
      (statement) => statement.label === "nationality.ceremony.attempt.insert",
    );
    expect(inserted?.values).toEqual([
      "ceremony-next",
      "user-1",
      "community_creation",
      "intent-1",
      2,
      compiledNationality.requirementHash,
      "zkpassport",
      zkBindingHash,
      "dynamic",
      "test:zkpassport",
      "1",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.any(String),
      600,
    ]);
  });

  test("refuses a superseded ceremony id and a draft requirement that moved", async () => {
    const superseded = resolverWith({
      "community.creation.resolve-nationality-intent": [
        nationalityRow({ current_ceremony_intent_id: "ceremony-2" }),
      ],
    }).resolver;
    await expect(Effect.runPromise(superseded.resolve(nationalityInput))).resolves.toBeNull();

    const changed = resolverWith({
      "community.creation.resolve-nationality-intent": [
        nationalityRow({ state_requirement_hash: "0".repeat(64) }),
      ],
    }).resolver;
    await expect(Effect.runPromise(changed.resolve(nationalityInput))).resolves.toBeNull();
  });

  test("leaves foreign action kinds and unknown providers to the other resolvers", async () => {
    const foreign = resolverWith({
      "community.creation.resolve-nationality-intent": [],
    }).resolver;
    await expect(Effect.runPromise(foreign.resolve(nationalityInput))).resolves.toBeNull();

    const unknownProvider = resolverWith({
      "community.creation.resolve-nationality-intent": [nationalityRow()],
    }).resolver;
    await expect(
      Effect.runPromise(unknownProvider.resolve({ ...nationalityInput, provider_id: "very.web" })),
    ).resolves.toBeNull();
  });

  test("fails closed when the resolver has no server-resolved authoring", async () => {
    const resolver = makeCommunityCreationIntentResolver(
      runtimeFor({
        "community.creation.resolve-nationality-intent": [nationalityRow()],
      }),
      "test",
    );
    await expect(Effect.runPromise(resolver.resolve(nationalityInput))).resolves.toBeNull();
  });
});
