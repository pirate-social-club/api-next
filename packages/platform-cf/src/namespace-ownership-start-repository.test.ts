import { describe, expect, test } from "bun:test";
import { ControlPlaneDb, type NamespaceOwnershipStartReservationInput } from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneNamespaceOwnershipStartRepository } from "./namespace-ownership-start-repository.ts";

const authorityRow = {
  intent_id: "intent-1",
  actor_id: "actor-1",
  revision: 3,
  status: "verification_required",
  intent_active: true,
  requirement_kind: "namespace_ownership",
  requirement_status: "pending",
  requirement_hash: "a".repeat(64),
  provider_id: "hns.owner.v1",
  provider_binding_hash: "b".repeat(64),
  provider_configuration_kind: "managed",
  provider_configuration_ref: "hns-config",
  provider_configuration_version: "1",
  protocol_version: "hns-txt-v1",
  environment: "test",
  route_family: "hns",
  route_root_label: "jazleeuw",
  route_root_label_display: "jazleeuw",
  route_path_segment: "app.jazleeuw",
  generation: 1,
  current_ceremony_intent_id: "ceremony-1",
  ceremony_requirement_kind: "namespace_ownership",
  ceremony_generation: 1,
  ceremony_requirement_hash: "a".repeat(64),
  ceremony_provider_id: "hns.owner.v1",
  ceremony_provider_binding_hash: "b".repeat(64),
  ceremony_provider_configuration_kind: "managed",
  ceremony_provider_configuration_ref: "hns-config",
  ceremony_provider_configuration_version: "1",
  ceremony_route_family: "hns",
  ceremony_route_root_label: "jazleeuw",
  ceremony_route_root_label_display: "jazleeuw",
  ceremony_route_path_segment: "app.jazleeuw",
  ceremony_active: true,
};

const startInput: NamespaceOwnershipStartReservationInput = {
  provider_id: "hns.owner.v1",
  start: {
    actor_id: "actor-1",
    creation_intent_id: "intent-1",
    ceremony_intent_id: "ceremony-1",
    requirement_hash: "a".repeat(64),
    generation: 1,
    request_hash: "c".repeat(64),
    provider_binding_hash: "b".repeat(64),
    provider_configuration: { kind: "managed", reference: "hns-config", version: "1" },
    protocol_version: "hns-txt-v1",
    environment: "test",
    route: {
      family: "hns",
      root_label: "jazleeuw",
      root_label_display: "jazleeuw",
      path_segment: "app.jazleeuw",
      href: "/c/app.jazleeuw",
      app_host: null,
    },
  },
  expected_revision: 3,
  client_idempotency_key: "key-1",
  reservation_id: "reservation-1",
  namespace_session_id: "namespace-session-1",
  ttl_ms: 6_000,
};

function fakeLayer(statements: { label: string; values: readonly unknown[] }[]) {
  const resultFor = (label: string) => {
    switch (label) {
      case "namespace-ownership.start.lock-actor":
        return { rows: [{ user_id: "actor-1" }], rowCount: 1 };
      case "namespace-ownership.start.lock-intent":
        return { rows: [{ intent_id: "intent-1" }], rowCount: 1 };
      case "namespace-ownership.start.lock-requirement":
        return { rows: [{ intent_id: "intent-1" }], rowCount: 1 };
      case "namespace-ownership.start.lock-ceremony":
      case "namespace-ownership.start.resolve-authority":
        return { rows: [authorityRow], rowCount: 1 };
      case "namespace-ownership.start.lock-key-reservation":
      case "namespace-ownership.start.lock-generation-reservation":
      case "namespace-ownership.start.lock-session":
        return { rows: [], rowCount: 0 };
      case "namespace-ownership.start.insert-reservation":
        return {
          rows: [
            {
              reservation_id: "reservation-1",
              namespace_session_id: "namespace-session-1",
              expected_revision: 3,
              request_hash: "c".repeat(64),
              state: "acquired",
              fence_token: 1,
              lease_expires_at: "2099-01-01T00:00:00.000Z",
            },
          ],
          rowCount: 1,
        };
      default:
        throw new Error(`unexpected SQL label ${label}`);
    }
  };
  const transaction = {
    execute: <Row>(statement: { readonly label: string; readonly values: readonly unknown[] }) =>
      Effect.sync(() => {
        statements.push({ label: statement.label, values: statement.values });
        return resultFor(statement.label) as unknown as { rows: readonly Row[]; rowCount: number };
      }),
  };
  return Layer.succeed(ControlPlaneDb, {
    execute: transaction.execute,
    withTransaction: <A, E, R>(use: (tx: typeof transaction) => Effect.Effect<A, E, R>) =>
      use(transaction),
  } as ControlPlaneDb["Service"]);
}

describe("namespace ownership start repository SQL boundary", () => {
  test("locks authority in order and persists the distinct HNS request hash", async () => {
    const statements: { label: string; values: readonly unknown[] }[] = [];
    const repository = makeControlPlaneNamespaceOwnershipStartRepository();
    const result = await Effect.runPromise(
      repository.reserve(startInput).pipe(Effect.provide(fakeLayer(statements))),
    );
    expect(result).toMatchObject({
      kind: "acquired",
      reservation: {
        reservation_id: "reservation-1",
        namespace_session_id: "namespace-session-1",
        expected_revision: 3,
        fence_token: 1,
      },
    });
    expect(statements.slice(0, 4).map(({ label }) => label)).toEqual([
      "namespace-ownership.start.lock-actor",
      "namespace-ownership.start.lock-intent",
      "namespace-ownership.start.lock-requirement",
      "namespace-ownership.start.lock-ceremony",
    ]);
    const insert = statements.find(
      ({ label }) => label === "namespace-ownership.start.insert-reservation",
    );
    expect(insert?.values[6]).toBe("a".repeat(64));
    expect(insert?.values[9]).toBe("c".repeat(64));
  });
});
