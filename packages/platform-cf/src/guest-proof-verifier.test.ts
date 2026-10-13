import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { makeControlPlaneGuestProofAuthority } from "./guest-proof-verifier.ts";
import {
  makeDirectPostgresControlPlaneLayer,
  type PostgresClientLike,
  type PostgresQueryConfig,
} from "./postgres.ts";

const origin = "https://community.example";
const original = "owner_00000000-0000-0000-0000-000000000001";
const effective = "owner_00000000-0000-0000-0000-000000000002";
const credentialId = "AAAAAAAAAAAAAAAAAAAAAA";
const digest = "a".repeat(64);
const observedAt = "2026-10-12T17:00:00.000Z";
const leaseUntil = "2026-10-12T18:00:00.000Z";
const proof = {
  ownerId: effective,
  credentialId,
  origin,
  state: "confirmed" as const,
  leaseUntil,
  pendingExpiresAt: "2026-10-12T16:15:00.000Z",
  predecessorCredentialId: null,
};
const credential = {
  ...proof,
  credentialSourceOwnerId: original,
  effectiveOwnerId: effective,
  pendingActive: false,
  learningLeaseActive: true,
};
const snapshot = {
  origin,
  databaseObservedAt: observedAt,
  provedCredentials: [credential],
  provedIntents: [],
};
const input = {
  origin,
  credentialProofs: [{ credentialId, digest }],
  intentProofs: [],
  cleanup: false,
};
const observation = {
  credential: {
    credentialId,
    credentialSourceOwnerId: original,
    effectiveOwnerId: effective,
    origin,
  },
  state: "confirmed",
  leaseUntil,
  databaseObservedAt: observedAt,
  active: true,
};

function fixture(rawSnapshot: unknown = snapshot, rawObservation: unknown = observation) {
  const queries: PostgresQueryConfig[] = [];
  const logs: unknown[] = [];
  const client: PostgresClientLike = {
    connect: async () => {},
    end: async () => {},
    query: async (query) => {
      queries.push(query);
      const row = query.text.includes("read_guest_browser_proof_snapshot_v1")
        ? { snapshot: rawSnapshot }
        : query.text.includes("read_guest_learning_lease_observation_v1")
          ? { observation: rawObservation }
          : null;
      return { rows: row === null ? [] : [row], rowCount: row === null ? 0 : 1 };
    },
  };
  const runtime = makeDirectPostgresControlPlaneLayer("postgres://fixture.invalid/guest", {
    clientFactory: () => client,
    logger: {
      info: (event, fields) => logs.push({ event, fields }),
      error: (event, fields) => logs.push({ event, fields }),
    },
  });
  return { ...makeControlPlaneGuestProofAuthority(runtime), queries, logs };
}

test("proof verifier keeps original/effective ownership private and projects only frozen metadata", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.snapshotReader.read(input))).toEqual(snapshot);
  expect(await Effect.runPromise(f.verifier.verify(input))).toEqual({
    origin,
    provedCredentials: [proof],
    provedIntents: [],
  });
  const projected = await Effect.runPromise(f.verifier.verify(input));
  expect(JSON.stringify(projected)).not.toContain("credentialSourceOwnerId");
  expect(JSON.stringify(projected)).not.toContain(digest);
  expect(JSON.stringify(f.logs)).not.toContain(digest);
  const commands = f.queries.map((query) => query.text);
  expect(
    commands.some(
      (text) =>
        text.includes("set_config('transaction_timeout','3s',true)") &&
        text.includes("set_config('lock_timeout','250ms',true)"),
    ),
  ).toBe(true);
  expect(
    commands.some((text) => text.startsWith("SELECT read_guest_browser_proof_snapshot_v1")),
  ).toBe(true);
});

test("malformed, excess, duplicate, unpresented and foreign-origin metadata refuses without retaining input", async () => {
  const malformed: unknown[] = [
    { ...snapshot, secret_digest: digest },
    { ...snapshot, origin: "https://other.example" },
    { ...snapshot, provedCredentials: [credential, credential] },
    { ...snapshot, provedCredentials: [{ ...credential, credentialId: "BBBBBBBBBBBBBBBBBBBBBA" }] },
    { ...snapshot, provedCredentials: [{ ...credential, ownerId: original }] },
    { ...snapshot, provedCredentials: [{ ...credential, origin: "https://other.example" }] },
    {
      ...snapshot,
      provedCredentials: [{ ...credential, state: "revoked", learningLeaseActive: true }],
    },
    { ...snapshot, provedCredentials: [{ ...credential, secret_digest: digest }] },
    { ...snapshot, databaseObservedAt: "not-an-instant" },
  ];
  for (const value of malformed) {
    const result = await Effect.runPromiseExit(fixture(value).verifier.verify(input));
    expect(Exit.isFailure(result)).toBe(true);
    if (!Exit.isFailure(result)) throw new Error("expected safe failure");
    const failure = Cause.findErrorOption(result.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (!Option.isSome(failure)) throw new Error("expected typed failure");
    expect(failure.value).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-proof.snapshot.decode",
    });
    expect(JSON.stringify(failure.value)).not.toContain(digest);
    expect(JSON.stringify(failure.value)).not.toContain("not-an-instant");
  }
});

test("pending and revoked proof metadata remain descriptive and never get a learning lease", async () => {
  for (const state of ["pending_bootstrap", "revoked"] as const) {
    const c = {
      ...credential,
      state,
      leaseUntil: state === "revoked" ? leaseUntil : null,
      learningLeaseActive: false,
    };
    const f = fixture({ ...snapshot, provedCredentials: [c] });
    const result = await Effect.runPromise(f.verifier.verify(input));
    expect(result.provedCredentials[0]?.state).toBe(state);
    expect(await f.isLearningLeaseActive(c)).toBe(false);
    expect(
      f.queries.some((query) => query.text.includes("read_guest_learning_lease_observation_v1")),
    ).toBe(false);
  }
});

test("learning follows fresh PostgreSQL observation rather than carried lease text or host clock", async () => {
  expect(
    await fixture(snapshot, { ...observation, active: false }).isLearningLeaseActive(proof),
  ).toBe(false);
  expect(await fixture(snapshot, null).isLearningLeaseActive(proof)).toBe(false);
  expect(await fixture(snapshot, observation).isLearningLeaseActive(proof)).toBe(true);
  const f = fixture();
  expect(await f.isLearningLeaseActive(proof)).toBe(true);
  const command = f.queries.find((query) =>
    query.text.includes("read_guest_learning_lease_observation_v1"),
  );
  expect(command?.values).toEqual([origin, credentialId, effective]);
  expect(command?.values).not.toContain(original);
});

test("fresh lease metadata cannot silently change selected credential, origin or effective source", async () => {
  for (const changed of [
    { ...observation.credential, credentialId: "BBBBBBBBBBBBBBBBBBBBBA" },
    { ...observation.credential, origin: "https://other.example" },
    { ...observation.credential, effectiveOwnerId: original },
  ]) {
    const f = fixture(snapshot, { ...observation, credential: changed });
    const exit = await Effect.runPromiseExit(f.observeLearningLease(proof));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected selected-source refusal");
    const failure = Cause.findErrorOption(exit.cause);
    if (!Option.isSome(failure)) throw new Error("expected typed refusal");
    expect(failure.value).toMatchObject({
      _tag: "ControlPlaneStatementFailed",
      label: "guest-proof.learning-lease.decode",
    });
  }
});
