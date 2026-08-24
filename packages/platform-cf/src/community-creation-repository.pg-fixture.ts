import type { CommunityCreationStore } from "@pirate/application";
import type { ProviderSessionStart } from "@pirate/application/verification";
import type { CommunityCreationIntentV1 } from "@pirate/contracts";
import {
  COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  communityCreationCeremonyReservationHash,
  communityCreationProviderBindingHash,
  communityNamespaceRequirementHash,
  compileCommunityGatePolicy,
  deriveCommunityRoute,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
} from "@pirate/domain";
import type { EvidenceBundle, ProofSession } from "@pirate/domain/verification";
import { Effect } from "effect";
import { Client } from "pg";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { makeControlPlaneNamespaceOwnershipCompletionStore } from "./namespace-ownership-completion-repository.ts";
import { makeControlPlaneNamespaceOwnershipStartStore } from "./namespace-ownership-start-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneVerificationCompletionStore } from "./verification-completion-repository.ts";
import { makeControlPlaneVerificationSessionStartStore } from "./verification-start-repository.ts";

const humanPolicy = {
  version: 1 as const,
  accessPaths: [
    {
      id: "verified-people",
      operator: "and" as const,
      requirements: [{ requirement: "human-verification" as const }],
    },
  ] as const,
};

export type CommunityCreationTestActor = Readonly<{
  readonly userId: string;
  readonly kind: "user";
}>;

async function runFixtureStage<A>(
  prefix: string,
  stage: string,
  run: () => Promise<A>,
): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw new Error(`${prefix}: ${stage} failed`, { cause });
  }
}

export function makeCommunityCreationStoreForTest(
  connection: string,
  ttlSeconds = 86_400,
  idPrefix = "intent",
): CommunityCreationStore["Service"] {
  let sequence = 0;
  return makeControlPlaneCommunityCreationStore(makeDirectPostgresControlPlaneLayer(connection), {
    intent_ttl_seconds: ttlSeconds,
    next_intent_id: () => `${idPrefix}-${++sequence}`,
    next_ceremony_intent_id: () => `${idPrefix}-ceremony-${sequence}`,
    next_community_id: () => `${idPrefix}-community`,
    next_route_binding_id: () => `${idPrefix}-route`,
    next_subject_claim_id: () => `${idPrefix}-subject-claim`,
    namespace_provider_bindings: [
      {
        requirement: "namespace_ownership",
        family: "hns",
        provider_id: "hns.owner.v1",
        provider_configuration: {
          kind: "managed",
          reference: "hns-owner-test",
          version: "1",
        },
        protocol_version: "hns-txt-v1",
      },
      {
        requirement: "namespace_ownership",
        family: "spaces",
        provider_id: "spaces.owner.disabled",
        provider_configuration: {
          kind: "managed",
          reference: "spaces-owner-disabled",
          version: "1",
        },
        protocol_version: "spaces-disabled-v1",
      },
    ],
  });
}

function veryEvidenceBundle(
  session: ProofSession,
  prefix: string,
  subjectDigest: string,
  evidenceHash: string,
): EvidenceBundle {
  if (session.scope.kind !== "named") throw new Error("expected the Very named scope");
  const subjectKeyId = `${prefix}-subject`;
  const receiptId = `${prefix}-receipt`;
  const bindingGroupId = `${prefix}-binding`;
  return {
    id: `${prefix}-bundle`,
    proof_session_id: session.id,
    subject_keys: [
      {
        id: subjectKeyId,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        subject_digest: subjectDigest,
      },
    ],
    receipts: [
      {
        id: receiptId,
        proof_session_id: session.id,
        provider_id: session.provider_id,
        issuer: session.scope.issuer,
        method: session.method,
        scope: session.scope,
        provider_configuration: session.provider_configuration,
        protocol_version: session.protocol_version,
        environment: session.environment,
        provenance_kind: "proof_session",
        evidence_kind: "very.web.server-verified.v1",
        evidence_hash: evidenceHash,
        metadata: { source: "test" },
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
        subject_key_id: subjectKeyId,
      },
    ],
    binding_groups: [{ id: bindingGroupId, kind: "same_subject", subject_key_id: subjectKeyId }],
    assertions: [
      {
        id: `${prefix}-unique`,
        subject_key_id: subjectKeyId,
        evidence_receipt_id: receiptId,
        claim_id: "credential.subject_unique",
        value: { subject_unique: true },
        assurance: "provider_attested",
        binding_group_id: bindingGroupId,
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
      },
      {
        id: `${prefix}-personhood`,
        subject_key_id: subjectKeyId,
        evidence_receipt_id: receiptId,
        claim_id: "human.personhood",
        value: { personhood: true },
        assurance: "provider_attested",
        binding_group_id: bindingGroupId,
        observed_at: "2026-08-21T00:00:30.000Z",
        expires_at: "2099-08-21T00:00:00.000Z",
      },
    ],
  };
}

async function seedRouteV1CreationIntent(
  connection: string,
  creationStore: CommunityCreationStore["Service"],
  input: Readonly<{
    readonly actor: CommunityCreationTestActor;
    readonly prefix: string;
    readonly rootLabel: string;
    readonly displayName?: string;
  }>,
): Promise<CommunityCreationIntentV1> {
  const intentId = `${input.prefix}-1`;
  const ceremonyIntentId = `${input.prefix}-ceremony-1`;
  const requestHash = "9".repeat(64);
  const draft = {
    name: input.displayName ?? input.prefix,
    description: null,
    route_request: { family: "hns" as const, root_label: input.rootLabel },
    policy: humanPolicy,
  };
  const compilation = compileCommunityGatePolicy(humanPolicy);
  const route = deriveCommunityRoute(draft.route_request);
  const namespaceRequirement = communityNamespaceRequirementHash(draft.route_request);
  if (
    compilation.kind !== "supported" ||
    route.kind !== "accepted" ||
    namespaceRequirement.kind !== "accepted"
  ) {
    throw new Error("expected a supported route-v1 test fixture");
  }
  const humanBinding = {
    requirement: "human_identity" as const,
    family: null,
    provider_id: VERY_WEB_PROVIDER_ID,
    provider_configuration: {
      kind: "dynamic" as const,
      reference: VERY_WEB_CONFIGURATION_REFERENCE,
      version: VERY_WEB_CONFIGURATION_VERSION,
    },
    protocol_version: VERY_WEB_PROTOCOL_VERSION,
  };
  const namespaceBinding = {
    requirement: "namespace_ownership" as const,
    family: "hns" as const,
    provider_id: "hns.owner.v1",
    provider_configuration: {
      kind: "managed" as const,
      reference: "hns-owner-test",
      version: "1",
    },
    protocol_version: "hns-txt-v1",
  };
  const humanBindingHash = communityCreationProviderBindingHash(humanBinding);
  const namespaceBindingHash = communityCreationProviderBindingHash(namespaceBinding);
  const reservation = {
    actor_id: input.actor.userId,
    creation_intent_id: intentId,
    ceremony_intent_id: ceremonyIntentId,
    requirement: "human_identity" as const,
    generation: 1,
    requirement_hash: compilation.verification_requirement_hash,
    provider_id: humanBinding.provider_id,
    provider_binding_hash: humanBindingHash,
    route: null,
  };
  const reservationRequest = {
    ...reservation,
    version: COMMUNITY_CREATION_CEREMONY_RESERVATION_VERSION,
  };
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO community_creation_intents (
         intent_id, actor_id, create_idempotency_key, create_request_hash,
         revision, status, draft, canonical_policy_revision,
         canonical_policy_hash, verification_requirement_hash,
         verification_provider_id, provider_configuration_kind,
         provider_configuration_ref, provider_configuration_version,
         expires_at, creation_contract_version
       ) VALUES (
         $1, $2, $3, $4, 1, 'verification_required', $5::jsonb, 1,
         $6, $7, $8, $9, $10, $11,
         clock_timestamp() + interval '1 day', 'route_v1'
       )`,
      [
        intentId,
        input.actor.userId,
        `${input.prefix}-create`,
        requestHash,
        JSON.stringify(draft),
        compilation.canonical_policy_hash,
        compilation.verification_requirement_hash,
        humanBinding.provider_id,
        humanBinding.provider_configuration.kind,
        humanBinding.provider_configuration.reference,
        humanBinding.provider_configuration.version,
      ],
    );
    await client.query(
      `INSERT INTO community_creation_requirement_states (
         intent_id, actor_id, requirement_kind, status,
         requirement_hash, provider_id, provider_binding_hash,
         provider_configuration_kind, provider_configuration_ref,
         provider_configuration_version, route_family, route_root_label,
         route_root_label_display, route_path_segment, generation,
         current_ceremony_intent_id
       ) VALUES
       ($1, $2, 'human_identity', 'unmet', $3, $4, $5, $6, $7, $8,
        NULL, NULL, NULL, NULL, 0, NULL),
       ($1, $2, 'namespace_ownership', 'unmet', $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, 0, NULL)`,
      [
        intentId,
        input.actor.userId,
        compilation.verification_requirement_hash,
        humanBinding.provider_id,
        humanBindingHash,
        humanBinding.provider_configuration.kind,
        humanBinding.provider_configuration.reference,
        humanBinding.provider_configuration.version,
        namespaceRequirement.value,
        namespaceBinding.provider_id,
        namespaceBindingHash,
        namespaceBinding.provider_configuration.kind,
        namespaceBinding.provider_configuration.reference,
        namespaceBinding.provider_configuration.version,
        route.value.family,
        route.value.root_label,
        route.value.root_label_display,
        route.value.path_segment,
      ],
    );
    await client.query(
      `INSERT INTO community_creation_ceremony_attempts (
         ceremony_intent_id, actor_id, intent_id, requirement_kind,
         generation, requirement_hash, provider_id, provider_binding_hash,
         provider_configuration_kind, provider_configuration_ref,
         provider_configuration_version, route_family, route_root_label,
         route_root_label_display, route_path_segment,
         reservation_request_hash, reservation_request, expires_at
       ) SELECT $1, $2, $3, 'human_identity', 1, $4, $5, $6, $7, $8, $9,
                NULL, NULL, NULL, NULL, $10, $11::jsonb, intent.expires_at
           FROM community_creation_intents AS intent
          WHERE intent.intent_id = $3 AND intent.actor_id = $2`,
      [
        ceremonyIntentId,
        input.actor.userId,
        intentId,
        compilation.verification_requirement_hash,
        humanBinding.provider_id,
        humanBindingHash,
        humanBinding.provider_configuration.kind,
        humanBinding.provider_configuration.reference,
        humanBinding.provider_configuration.version,
        communityCreationCeremonyReservationHash(reservation),
        JSON.stringify(reservationRequest),
      ],
    );
    await client.query(
      `UPDATE community_creation_requirement_states
          SET status = 'pending', generation = 1,
              current_ceremony_intent_id = $1, updated_at = clock_timestamp()
        WHERE intent_id = $2 AND actor_id = $3
          AND requirement_kind = 'human_identity'
          AND status = 'unmet' AND generation = 0`,
      [ceremonyIntentId, intentId, input.actor.userId],
    );
    await client.query("COMMIT");

    const document = await Effect.runPromise(creationStore.get({ actor: input.actor, intentId }));
    if (document === null || "creation_contract_version" in document) {
      throw new Error("expected a route-v1 creation intent");
    }
    await client.query(
      `INSERT INTO community_creation_intent_revisions (
         intent_id, revision, actor_id, operation_kind, idempotency_key,
         request_hash, status, state_snapshot
       ) VALUES ($1, 1, $2, 'create', $3, $4, $5, $6::jsonb)`,
      [
        intentId,
        input.actor.userId,
        `${input.prefix}-create`,
        requestHash,
        document.status,
        JSON.stringify(document),
      ],
    );
    return document;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    await client.end();
  }
}

export async function prepareCommitReadyCommunity(
  input: Readonly<{
    readonly connection: string;
    readonly actor: CommunityCreationTestActor;
    readonly prefix: string;
    readonly rootLabel: string;
    readonly displayName?: string;
    readonly subjectDigest?: string;
    readonly veryStartRequestHash?: string;
    readonly veryEvidenceHash?: string;
  }>,
) {
  const { connection, actor, prefix, rootLabel } = input;
  const creationStore = makeCommunityCreationStoreForTest(connection, 86_400, prefix);
  const document = await seedRouteV1CreationIntent(connection, creationStore, {
    actor,
    prefix,
    rootLabel,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
  });
  if (document.next_action.kind !== "start_verification") {
    throw new Error("expected the human creation ceremony");
  }

  const providerInput = {
    actor_id: actor.userId,
    intent_id: document.next_action.ceremony_intent_id,
    request_hash: input.veryStartRequestHash ?? "8".repeat(64),
    method: "palm_web",
    scope: {
      kind: "named" as const,
      scope_semantics: "issuer_rp_scope" as const,
      issuer: "https://verify.very.org",
      rp_scope: "pirate-social",
    },
    request_mode: "dynamic" as const,
    provider_configuration: { kind: "dynamic" as const, reference: "very-web", version: "1" },
    requested_requirements: [
      { claim_id: "credential.subject_unique" as const },
      { claim_id: "human.personhood" as const },
    ],
    requested_claim_ids: ["credential.subject_unique" as const, "human.personhood" as const],
    subject_binding_intent: "establish" as const,
    protocol_version: "very-web-v1",
    environment: "test",
  } as const;
  const reservationInput = {
    start: providerInput,
    ttl_ms: 60_000,
    creation: {
      creation_intent_id: document.intent_id,
      requirement: "human_identity" as const,
      generation: document.next_action.generation,
      expected_revision: document.revision,
      idempotency_key: `${prefix}-launch`,
      provider_id: "very.web",
    },
  };
  const startStore = makeControlPlaneVerificationSessionStartStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const reserved = await Effect.runPromise(Effect.scoped(startStore.reserve(reservationInput)));
  if (reserved.kind !== "acquired") throw new Error("expected an acquired reservation");
  const providerStart: ProviderSessionStart = {
    session: {
      id: `${prefix}-proof`,
      ...providerInput,
      provider_id: "very.web",
      upstream_session_ref: `${prefix}-very-upstream`,
      status: "pending",
      started_at: "2026-08-21T00:00:00.000Z",
      expires_at: "2099-08-21T00:00:00.000Z",
    },
    presentation: {
      kind: "redirect",
      session_id: `${prefix}-proof`,
      url: `https://very.example/verify/${prefix}`,
    },
  };
  const finalized = await Effect.runPromise(
    Effect.scoped(startStore.finalize(reserved.reservation, providerStart)),
  );
  if (finalized.kind !== "created") throw new Error("expected a created Very session");

  const completionStore = makeControlPlaneVerificationCompletionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const humanReservation = await Effect.runPromise(
    Effect.scoped(
      completionStore.reserveAttempt({
        proof_session_id: providerStart.session.id,
        idempotency_key: `${prefix}-complete`,
        lease_ms: 60_000,
        max_consumed_attempts: 3,
      }),
    ),
  );
  if (humanReservation.kind !== "acquired") {
    throw new Error("expected a human completion reservation");
  }
  const humanCompletion = await runFixtureStage(prefix, "Very completion", () =>
    Effect.runPromise(
      Effect.scoped(
        completionStore.commit({
          actor_id: actor.userId,
          idempotency_key: `${prefix}-complete`,
          attempt: humanReservation.reservation,
          expected_session: providerStart.session,
          result_hash: "6".repeat(64),
          bundle: veryEvidenceBundle(
            providerStart.session,
            prefix,
            input.subjectDigest ?? "d".repeat(64),
            input.veryEvidenceHash ?? "6".repeat(64),
          ),
        }),
      ),
    ),
  );
  if (humanCompletion.kind !== "committed") {
    throw new Error("expected committed Very evidence");
  }

  const namespacePending = await Effect.runPromise(
    creationStore.get({ actor, intentId: document.intent_id }),
  );
  if (namespacePending?.next_action.kind !== "start_verification") {
    throw new Error("expected the namespace ownership ceremony");
  }
  if ("creation_contract_version" in namespacePending) {
    throw new Error("expected a historical route-v1 creation intent");
  }
  const namespaceBindingHash = communityCreationProviderBindingHash({
    requirement: "namespace_ownership",
    family: "hns",
    provider_id: "hns.owner.v1",
    provider_configuration: {
      kind: "managed",
      reference: "hns-owner-test",
      version: "1",
    },
    protocol_version: "hns-txt-v1",
  });
  const namespaceStartInput = {
    provider_id: "hns.owner.v1",
    start: {
      actor_id: actor.userId,
      creation_intent_id: document.intent_id,
      ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
      requirement_hash: namespacePending.requirements.namespace_ownership.requirement_hash,
      generation: namespacePending.next_action.generation,
      request_hash: "7".repeat(64),
      provider_binding_hash: namespaceBindingHash,
      provider_configuration: {
        kind: "managed" as const,
        reference: "hns-owner-test",
        version: "1",
      },
      protocol_version: "hns-txt-v1",
      environment: "test",
      route: {
        family: "hns" as const,
        root_label: rootLabel,
        root_label_display: rootLabel,
        path_segment: `app.${rootLabel}`,
        href: `/c/app.${rootLabel}`,
        app_host: null,
      },
    },
    expected_revision: namespacePending.revision,
    client_idempotency_key: `${prefix}-namespace-start`,
    reservation_id: `${prefix}-namespace-reservation`,
    namespace_session_id: `${prefix}-namespace-session`,
    ttl_ms: 60_000,
  } as const;
  const namespaceStartStore = makeControlPlaneNamespaceOwnershipStartStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const namespaceReservation = await Effect.runPromise(
    Effect.scoped(namespaceStartStore.reserve(namespaceStartInput)),
  );
  if (namespaceReservation.kind !== "acquired") {
    throw new Error("expected a namespace start reservation");
  }
  const namespaceStarted = await Effect.runPromise(
    Effect.scoped(
      namespaceStartStore.finalize(namespaceReservation.reservation, {
        session: {
          ...namespaceStartInput.start,
          provider_id: namespaceStartInput.provider_id,
          upstream_session_ref: `${prefix}-namespace-upstream`,
          expires_at: "2099-08-21T00:00:00.000Z",
        },
        presentation: {
          kind: "embedded_sdk",
          session_id: `${prefix}-namespace-upstream`,
          protocol: "hns-txt-challenge",
          version: "1",
          payload: {
            ownership_source: "owner_authoritative_dns_txt",
            challenge_name: `_pirate.${namespaceStartInput.start.route.root_label}`,
            challenge_value: `pirate-verification=${prefix}-namespace-upstream`,
            expires_at: "2099-08-21T00:00:00.000Z",
          },
        },
      }),
    ),
  );
  if (namespaceStarted.kind !== "created") throw new Error("expected a namespace session");

  const namespaceCompletionStore = makeControlPlaneNamespaceOwnershipCompletionStore(
    makeDirectPostgresControlPlaneLayer(connection),
  );
  const namespaceStored = await Effect.runPromise(
    Effect.scoped(
      namespaceCompletionStore.load({
        actor_id: actor.userId,
        creation_intent_id: document.intent_id,
        ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
        session_id: namespaceStartInput.namespace_session_id,
      }),
    ),
  );
  if (namespaceStored === null) throw new Error("expected the namespace completion authority");
  const namespaceCompletionInput = {
    actor_id: actor.userId,
    creation_intent_id: document.intent_id,
    ceremony_intent_id: namespacePending.next_action.ceremony_intent_id,
    session_id: namespaceStartInput.namespace_session_id,
    expected_revision: namespacePending.revision,
    idempotency_key: `${prefix}-namespace-complete`,
    completion_request_hash: "8".repeat(64),
    expired_result_hash: "9".repeat(64),
    completion_attempt_id: `${prefix}-namespace-completion-attempt`,
    evidence_ref: `${prefix}-namespace-evidence`,
    lease_ms: 60_000,
    max_consumed_attempts: 3,
  } as const;
  const namespaceCompletionReservation = await Effect.runPromise(
    Effect.scoped(namespaceCompletionStore.reserve(namespaceCompletionInput)),
  );
  if (namespaceCompletionReservation.kind !== "acquired") {
    throw new Error("expected a namespace completion reservation");
  }
  const rawResponse = Buffer.from('{"status":"verified"}', "utf8");
  const namespaceCompletion = await Effect.runPromise(
    Effect.scoped(
      namespaceCompletionStore.verify({
        actor_id: actor.userId,
        expected: namespaceStored,
        idempotency_key: namespaceCompletionInput.idempotency_key,
        completion_request_hash: namespaceCompletionInput.completion_request_hash,
        result_hash: "a".repeat(64),
        expired_result_hash: namespaceCompletionInput.expired_result_hash,
        attempt: namespaceCompletionReservation.reservation,
        verified: {
          envelope: {
            version: "pirate-hns-ownership-evidence-v1",
            actor_id: actor.userId,
            creation_intent_id: document.intent_id,
            requirement: "namespace_ownership",
            requirement_hash: namespaceStored.session.requirement_hash,
            ceremony_intent_id: namespaceStored.session.ceremony_intent_id,
            generation: namespaceStored.session.generation,
            request_hash: namespaceStored.session.request_hash,
            provider_id: namespaceStored.session.provider_id,
            provider_binding_hash: namespaceStored.session.provider_binding_hash,
            provider_configuration_kind: namespaceStored.session.provider_configuration.kind,
            provider_configuration_reference:
              namespaceStored.session.provider_configuration.reference,
            provider_configuration_version: namespaceStored.session.provider_configuration.version,
            protocol_version: namespaceStored.session.protocol_version,
            environment: namespaceStored.session.environment,
            family: "hns",
            root_label: namespaceStored.session.route.root_label,
            root_label_display: namespaceStored.session.route.root_label_display,
            path_segment: namespaceStored.session.route.path_segment,
            upstream_session_ref: namespaceStored.session.upstream_session_ref,
            ownership_source: "owner_authoritative_dns_txt",
            challenge_name: `_pirate.${namespaceStored.session.route.root_label}`,
            challenge_value_sha256: "b".repeat(64),
            root_exists: true,
            root_control_verified: true,
            expiry_horizon_sufficient: true,
            chain_network: "regtest",
            chain_anchor_height: 123,
            chain_anchor_block_hash: "c".repeat(64),
            chain_anchor_median_time: 456,
            expiry_height: 789,
            observed_at: "2026-08-21T00:01:00.000Z",
            expires_at: "2099-08-21T00:00:00.000Z",
            evidence_ref: namespaceCompletionReservation.reservation.evidence_ref,
            provider_evidence_ref: `${prefix}-provider-evidence`,
            observation_sha256: "d".repeat(64),
            provider_identity_digest: "e".repeat(64),
            evidence_digest: "f".repeat(64),
          },
          observation: {
            status: "verified",
            provider_evidence_ref: `${prefix}-provider-evidence`,
          },
          raw_response_bytes: rawResponse,
        },
      }),
    ),
  );
  if (namespaceCompletion.kind !== "committed") {
    throw new Error("expected committed namespace evidence");
  }

  const ready = await Effect.runPromise(creationStore.get({ actor, intentId: document.intent_id }));
  if (ready?.status !== "commit_ready" || ready.next_action.kind !== "commit") {
    throw new Error("expected a commit-ready creation intent");
  }
  return {
    actor,
    store: creationStore,
    document,
    ready,
    commitInput: {
      actor,
      intentId: document.intent_id,
      requestHash: "1".repeat(64),
      body: {
        idempotency_key: `${prefix}-commit`,
        expected_revision: ready.revision,
      },
    } as const,
    communityId: `${prefix}-community`,
    routeBindingId: `${prefix}-route`,
    subjectClaimId: `${prefix}-subject-claim`,
  } as const;
}
