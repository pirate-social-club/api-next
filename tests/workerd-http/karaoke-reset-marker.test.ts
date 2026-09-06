/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import { KARAOKE_RESET_MARKER_KEY } from "../../packages/platform-cf/src/karaoke-reset-marker.ts";

const env = testEnv as unknown as {
  readonly KARAOKE_ATTEMPT: DurableObjectNamespace<KaraokeAttemptDO>;
};

describe("persisted Karaoke reset marker denial", () => {
  for (const suspendedAt of ["create", "complete"] as const) {
    it(`issues no further R2 work after fencing during multipart ${suspendedAt}`, async () => {
      const stub = env.KARAOKE_ATTEMPT.getByName(`in-flight-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (_instance, state) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const calls = { create: 0, part: 0, complete: 0, get: 0, abort: 0 };
        const upload = {
          uploadId: "late-upload-id",
          async abort() {
            calls.abort += 1;
          },
          async complete() {
            calls.complete += 1;
            entered.resolve();
            await release.promise;
          },
          async uploadPart() {
            calls.part += 1;
            return { partNumber: 1, etag: "part-etag" };
          },
        };
        const object = new KaraokeAttemptDO(state, {
          get CONTROL_PLANE(): never {
            throw new Error("unexpected_hyperdrive");
          },
          LEARNER_AUDIO: {
            async createMultipartUpload() {
              calls.create += 1;
              entered.resolve();
              await release.promise;
              return upload;
            },
            resumeMultipartUpload() {
              return upload;
            },
            async get() {
              calls.get += 1;
              return null;
            },
          },
        });
        await state.blockConcurrencyWhile(async () => {});
        state.storage.sql.exec(
          `INSERT INTO karaoke_archive
            (id,upload_id,object_key,next_part,parts_json,byte_size,duration_ms,state)
           VALUES (1,?,'karaoke/fixture/attempt.pcm',2,?,2,1,'pending')`,
          suspendedAt === "complete" ? upload.uploadId : null,
          suspendedAt === "complete"
            ? JSON.stringify([{ partNumber: 1, etag: "part-etag" }])
            : "[]",
        );
        if (suspendedAt === "create") {
          state.storage.sql.exec(
            "INSERT INTO karaoke_audio_chunk VALUES (1,?,2)",
            new Uint8Array([0, 0]).buffer,
          );
        }
        // Exercise the actual private producer boundary without exposing a test RPC.
        const finish = Reflect.get(object, "finishArchive");
        if (typeof finish !== "function") throw new Error("missing_archive_producer");
        const work = finish.call(object);
        const rejected = expect(work).rejects.toThrow("karaoke_reset_fenced");
        await entered.promise;
        await state.storage.put(KARAOKE_RESET_MARKER_KEY, { version: 1, state: "active" });
        Reflect.set(object, "resetFenced", true);
        release.resolve();
        await rejected;
        expect(calls).toEqual({
          create: suspendedAt === "create" ? 1 : 0,
          part: 0,
          complete: suspendedAt === "complete" ? 1 : 0,
          get: 0,
          abort: 0,
        });
        expect(
          state.storage.sql
            .exec<{ upload_id: string }>("SELECT upload_id FROM karaoke_archive WHERE id=1")
            .one().upload_id,
        ).toBe("late-upload-id");
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
