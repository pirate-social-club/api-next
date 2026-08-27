import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  makePlatformPirateHandleService,
  type PlatformPirateHandleStore,
  PlatformPirateRenameRejected,
} from "./platform-pirate-rename.ts";

const store = (overrides: Partial<PlatformPirateHandleStore> = {}): PlatformPirateHandleStore => ({
  checkAvailability: () => Effect.succeed({ kind: "available" }),
  rename: () => Effect.succeed({ kind: "handle_unavailable" }),
  ...overrides,
});

describe("platform Pirate handle application service", () => {
  test("rejects invalid labels before storage and returns the frozen availability policy", async () => {
    let calls = 0;
    const service = makePlatformPirateHandleService(
      store({
        checkAvailability: () => {
          calls += 1;
          return Effect.succeed({ kind: "available" });
        },
      }),
    );
    expect(
      await Effect.runPromise(
        service.checkAvailability({
          accountId: "account",
          personaId: "persona",
          platformHandleId: "handle",
          desiredLabel: "Captain",
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "invalid_label" });
    expect(calls).toBe(1);
    const available = await Effect.runPromise(
      service.checkAvailability({
        accountId: "account",
        personaId: "persona",
        platformHandleId: "handle",
        desiredLabel: "captain-data",
      }),
    );
    expect(available).toMatchObject({
      kind: "available",
      desired_label: "captain-data",
      display_identifier: "captain-data.pirate",
      policy: {
        label_policy_hash: "7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873",
      },
    });
  });

  test("binds the private account and every command field into the store request hash", async () => {
    let observed = "";
    const service = makePlatformPirateHandleService(
      store({
        rename: (input) => {
          observed = input.requestHash;
          return Effect.succeed({ kind: "stale_platform_handle" });
        },
      }),
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        service.rename({
          accountId: "account_private_01",
          personaId: "persona_public_01",
          platformHandleId: "platform_handle_01",
          expectedStateHash: "ccae7462c76c083336c67a4081fa52af70082fb67b716dc4be7820c2e1536fe2",
          desiredLabel: "captain-data",
          idempotencyKey: "rename-key-01",
        }),
      ),
    );
    expect(observed).toBe("9b7ff2631eab537cd24e4445da1cf0d8e767f7af795cccc4938736de88a18f22");
    expect(failure).toEqual(new PlatformPirateRenameRejected({ reason: "stale_platform_handle" }));
  });
});
