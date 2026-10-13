/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import { KARAOKE_RESET_MARKER_KEY } from "../../packages/platform-cf/src/karaoke-reset-marker.ts";
import {
  admitCapturedArchiveFixture,
  bounded,
  enteredOrSettled,
  finishArchive,
  handled,
  type Settlement,
} from "./karaoke-reset-captured.fixture.ts";

const env = testEnv as unknown as {
  readonly KARAOKE_ATTEMPT: DurableObjectNamespace<KaraokeAttemptDO>;
};

describe("persisted Karaoke reset marker denial", () => {
  for (const suspendedAt of ["create", "complete"] as const) {
    it(`records late multipart ${suspendedAt} facts but blocks later writes/publication after fencing`, async () => {
      const stub = env.KARAOKE_ATTEMPT.getByName(`in-flight-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (_instance, state) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const calls = {
          create: 0,
          part: 0,
          complete: 0,
          get: 0,
          abort: 0,
          delete: 0,
          hyperdrive: 0,
        };
        let admitted: Awaited<ReturnType<typeof admitCapturedArchiveFixture>> | null = null;
        const outsideTransaction = () => {
          if (admitted === null) throw new Error("capture not admitted");
          expect(admitted.inTransaction()).toBe(false);
        };
        const upload = {
          uploadId: "late-upload-id",
          async abort() {
            outsideTransaction();
            calls.abort += 1;
            throw new Error("unexpected_abort");
          },
          async complete() {
            outsideTransaction();
            calls.complete += 1;
            if (suspendedAt === "complete") {
              entered.resolve();
              await release.promise;
            }
          },
          async uploadPart() {
            outsideTransaction();
            calls.part += 1;
            return { partNumber: 1, etag: "part-etag" };
          },
        };
        const bucket = {
          async delete() {
            outsideTransaction();
            calls.delete += 1;
            throw new Error("unexpected_delete");
          },
          async createMultipartUpload() {
            outsideTransaction();
            calls.create += 1;
            if (suspendedAt === "create") {
              entered.resolve();
              await release.promise;
            }
            return upload;
          },
          resumeMultipartUpload() {
            return upload;
          },
          async get() {
            outsideTransaction();
            calls.get += 1;
            return {
              size: 2,
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([0, 0]));
                  controller.close();
                },
              }),
            };
          },
        };
        const object = new KaraokeAttemptDO(state, {
          get CONTROL_PLANE(): never {
            calls.hyperdrive += 1;
            throw new Error("unexpected_hyperdrive");
          },
          LEARNER_AUDIO: bucket,
        });
        await bounded(
          state.blockConcurrencyWhile(async () => {}),
          "marker-constructor-barrier",
        );
        admitted = await admitCapturedArchiveFixture(object, state, bucket);
        let settled: Promise<Settlement<unknown>> | null = null;
        try {
          // Original producer tracker and reset guard execute. Only its already
          // admitted native authority is substituted at the finite driver seam.
          settled = handled(finishArchive(object));
          await enteredOrSettled(entered.promise, settled, `marker-${suspendedAt}-entry`);
          await state.storage.put(KARAOKE_RESET_MARKER_KEY, { version: 1, state: "active" });
          Reflect.set(object, "resetFenced", true);
          release.resolve();
          const result = await bounded(settled, `marker-${suspendedAt}-settlement`);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(String(result.error)).toContain("karaoke_reset_fenced");
          expect(calls).toEqual({
            create: 1,
            part: suspendedAt === "complete" ? 1 : 0,
            complete: suspendedAt === "complete" ? 1 : 0,
            get: suspendedAt === "complete" ? 1 : 0,
            abort: 0,
            delete: 0,
            hyperdrive: 0,
          });
          const journal = admitted.journal.load();
          expect(journal.multipartId).toBe("late-upload-id");
          expect(journal.inFlight).toBeNull();
          if (suspendedAt === "create") {
            expect(journal.completed).toBe(false);
            expect(journal.result).toBeNull();
            expect(admitted.facts).toHaveLength(0);
            expect(admitted.nativeState().ioState).toBe("writing");
          } else {
            expect(journal.completed).toBe(true);
            expect(journal.result).toMatchObject({ state: "stored", byteSize: 2 });
            expect(admitted.facts).toHaveLength(1);
            expect(admitted.nativeState()).toMatchObject({
              ioState: "closed",
              storageDisposition: "stored",
            });
          }
          const before = { ...calls };
          const reentry = await bounded(handled(finishArchive(object)), "marker-fenced-reentry");
          expect(reentry.ok).toBe(false);
          expect(calls).toEqual(before);
        } finally {
          release.resolve();
          if (settled !== null) await bounded(settled, `marker-${suspendedAt}-cleanup`);
        }
      });
    });
  }

  for (const marker of [
    "active",
    "retired",
    null,
    { version: 999 },
    { version: 1, state: "active", objectId: "mismatched" },
    { version: 1, state: "retired", objectId: "mismatched" },
  ]) {
    it(`denies before business initialization for ${JSON.stringify(marker)}`, async () => {
      const stub = env.KARAOKE_ATTEMPT.getByName(`fenced-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (_instance, state) => {
        const stored =
          typeof marker === "string"
            ? {
                version: 1,
                state: marker,
                namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
                objectId: state.id.toString(),
                generation: "staging-reset-v1",
              }
            : marker;
        await state.storage.put(KARAOKE_RESET_MARKER_KEY, stored);
        await state.storage.setAlarm(Date.now() + 60_000);
        const tables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'karaoke_%'",
          )
          .toArray();
        for (const { name } of tables) {
          if (!/^karaoke_[a-z_]+$/u.test(name)) throw new Error("unexpected_fixture_table");
          state.storage.sql.exec(`DROP TABLE ${name}`);
        }
        const calls = { hyperdrive: 0, r2: 0 };
        // Construct the real class against real durable storage, with counting
        // denial adapters for dependencies that must never be reached.
        const object = new KaraokeAttemptDO(state, {
          // No environment or enabling variable is supplied.
          get CONTROL_PLANE(): never {
            calls.hyperdrive += 1;
            throw new Error("unexpected_hyperdrive");
          },
          get LEARNER_AUDIO(): never {
            calls.r2 += 1;
            throw new Error("unexpected_r2");
          },
        });
        await state.blockConcurrencyWhile(async () => {
          await state.storage.get(KARAOKE_RESET_MARKER_KEY);
        });
        expect((await object.fetch(new Request("https://test.invalid"))).status).toBe(503);
        expect(await object.redriveFinalization()).toEqual({ outcome: "fenced", rearmed: [] });
        const sockets = new WebSocketPair();
        await object.webSocketMessage(sockets[1], "{}");
        await object.webSocketMessage(sockets[1], new ArrayBuffer(0));
        await object.webSocketClose();
        await object.webSocketError();
        await object.alarm();
        // A queued/retried delivery must remain inert after cancellation.
        await object.alarm();
        expect(await state.storage.getAlarm()).toBeNull();
        expect(() => object.authority()).toThrow("karaoke_reset_fenced");
        expect(calls).toEqual({ hyperdrive: 0, r2: 0 });
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'karaoke_%'")
            .toArray(),
        ).toEqual([]);
        expect(await state.storage.get(KARAOKE_RESET_MARKER_KEY)).toEqual(stored);
      });
    });
  }
});
