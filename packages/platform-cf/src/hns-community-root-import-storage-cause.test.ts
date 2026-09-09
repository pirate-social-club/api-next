import { expect, test } from "bun:test";
import {
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  HnsCommunityRootImportStorageFailed,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import { makeControlPlaneHnsCommunityRootImportStartStore } from "./hns-community-root-import-repository.ts";

const binding = {
  requirement: "namespace_ownership" as const,
  family: "hns" as const,
  provider_id: "hns.owner.v1",
  provider_configuration: { kind: "managed" as const, reference: "hns-owner-test", version: "1" },
  protocol_version: "hns-txt-v1",
};

// Effect v4 has no `Layer.fail`; a failing layer is an effect layer that fails.
const failingLayer = (error: unknown) => Layer.effect(ControlPlaneDb)(Effect.fail(error)) as never;

const storeFailingWith = (error: unknown) =>
  makeControlPlaneHnsCommunityRootImportStartStore(failingLayer(error), {
    environment: "test",
    provider_binding: binding,
  });

// The store port exposes one opaque storage failure by design. Discarding the
// control-plane error while narrowing to it removed the only description of what
// actually failed, one layer below the handler that then replaced the domain
// failure with a fixed sentence.
test("a control-plane failure is carried as the cause of the opaque storage failure", async () => {
  const statementFailed = new ControlPlaneStatementFailed({
    label: "hns.community-root-import.insert-intent",
    sqlState: "23505",
    constraint: "community_route_attachment_intents_one_open_per_community_uidx",
    outcomeCertainty: "completed",
  });

  const failure = await Effect.runPromise(
    storeFailingWith(statementFailed)
      .getCurrent({ actor_id: "user_1", community_id: "community_1" })
      .pipe(Effect.flip),
  );

  expect(failure).toBeInstanceOf(HnsCommunityRootImportStorageFailed);
  expect(failure.cause).toBe(statementFailed);
});

test("an already-opaque failure is not wrapped a second time", async () => {
  const storage = new HnsCommunityRootImportStorageFailed({});

  const failure = await Effect.runPromise(
    storeFailingWith(storage)
      .getCurrent({ actor_id: "user_1", community_id: "community_1" })
      .pipe(Effect.flip),
  );

  expect(failure).toBe(storage);
  expect(failure.cause).toBeUndefined();
});
