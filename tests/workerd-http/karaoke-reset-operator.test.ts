/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext, runInDurableObject, env as testEnv } from "cloudflare:test";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import {
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_OBJECT_IDS,
  type KaraokeResetReceipt,
  verifyKaraokeResetReceipts,
} from "../../packages/platform-cf/src/karaoke-reset-installation.ts";
import { KARAOKE_RESET_MARKER_KEY } from "../../packages/platform-cf/src/karaoke-reset-marker.ts";
import { admitKaraokeResetOperator } from "../../packages/platform-cf/src/karaoke-reset-operator-auth.ts";
import { KaraokeResetOperatorEntrypoint } from "../../packages/platform-cf/src/karaoke-reset-operator-entrypoint.ts";

const network = setupNetwork();
const bindings = {
  API_NEXT_ENV: "staging",
  KARAOKE_RESET_ENABLED: "true",
  KARAOKE_RESET_ACCESS_ISSUER: "https://reset-test.cloudflareaccess.com",
  KARAOKE_RESET_ACCESS_AUDIENCE: "reset-test-audience",
  KARAOKE_RESET_ACCESS_SUBJECT: "reset-test-operator",
};
const env = testEnv as typeof testEnv & {
  KARAOKE_ATTEMPT: DurableObjectNamespace<KaraokeAttemptDO>;
  RESET_OPERATOR: Service<KaraokeResetOperatorEntrypoint>;
};
let keys: CryptoKeyPair;
let jwk: import("node:crypto").webcrypto.JsonWebKey;
let jwksRequests = 0;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function assertion(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  const input = `${encode({ alg: "RS256", kid: "reset-test-key" })}.${encode({
    iss: bindings.KARAOKE_RESET_ACCESS_ISSUER,
    aud: bindings.KARAOKE_RESET_ACCESS_AUDIENCE,
    sub: bindings.KARAOKE_RESET_ACCESS_SUBJECT,
    iat: now - 1,
    exp: now + 300,
    ...overrides,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}
const command = (objectId: string, state: "active" | "retired" = "active") => ({
  namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
  objectId,
  generation: KARAOKE_RESET_GENERATION,
  inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
  state,
});

// Local namespace IDs cannot be staging IDs. Substitute only the observed ID;
// storage, input barriers, alarms, authentication and installation are real.
function useFixtureIdentity(
  object: KaraokeAttemptDO,
  state: DurableObjectState,
  objectId: string,
  options: {
    persisted?: () => void;
    failCancellation?: boolean;
    alarmWritten?: () => Promise<void>;
  } = {},
) {
  Reflect.set(object, "runtimeCtx", {
    id: { toString: () => objectId },
    storage: {
      sql: state.storage.sql,
      get: state.storage.get.bind(state.storage),
      getAlarm: state.storage.getAlarm.bind(state.storage),
      async setAlarm(time: number | Date) {
        await state.storage.setAlarm(time);
        await options.alarmWritten?.();
      },
      async put(entries: Record<string, unknown>) {
        await state.storage.put(entries);
        if (Object.hasOwn(entries, KARAOKE_RESET_MARKER_KEY)) options.persisted?.();
      },
      async deleteAlarm() {
        if (options.failCancellation) throw new Error("fixture_cancellation_failed");
        await state.storage.deleteAlarm();
      },
    },
    blockConcurrencyWhile: state.blockConcurrencyWhile.bind(state),
    getWebSockets: state.getWebSockets.bind(state),
    acceptWebSocket: state.acceptWebSocket.bind(state),
  });
}

describe("staging reset authenticated RPC", () => {
  beforeAll(async () => {
    keys = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    network.enable();
    network.use(
      http.get(`${bindings.KARAOKE_RESET_ACCESS_ISSUER}/cdn-cgi/access/certs`, () => {
        jwksRequests += 1;
        return HttpResponse.json({
          keys: [{ ...jwk, kid: "reset-test-key", alg: "RS256", use: "sig" }],
        });
      }),
    );
  });
  afterAll(() => network.disable());

  it("rejects an invalid assertion over the native named-service transport", async () => {
    let denied = false;
    try {
      await env.RESET_OPERATOR.apply("invalid", command(KARAOKE_RESET_OBJECT_IDS[0]));
    } catch (error) {
      denied = true;
      expect(String(error)).toContain("karaoke_reset_operator_denied");
    }
    expect(denied).toBe(true);
  });

  it("rejects disabled/production admission without networking and verifies the exact operator", async () => {
    const token = await assertion();
    const before = jwksRequests;
    const { KARAOKE_RESET_ENABLED: _enabled, ...disabled } = bindings;
    for (const configuration of [{ ...bindings, API_NEXT_ENV: "production" }, disabled]) {
      await expect(admitKaraokeResetOperator(configuration, token)).rejects.toThrow(
        "karaoke_reset_operator_denied",
      );
    }
    expect(jwksRequests).toBe(before);
    await expect(admitKaraokeResetOperator(bindings, token)).resolves.toBeUndefined();
    for (const claims of [{ sub: "other-operator" }, { aud: "other-audience" }, { exp: 1 }]) {
      await expect(admitKaraokeResetOperator(bindings, await assertion(claims))).rejects.toThrow(
        "karaoke_reset_operator_denied",
      );
    }
    await expect(
      admitKaraokeResetOperator(bindings, `${token.slice(0, -4)}AAAA`),
    ).rejects.toThrow();
  });

  it("installs all six through the entrypoint with local identity fixtures, then retires monotonically", async () => {
    const token = await assertion();
    const receipts: KaraokeResetReceipt[] = [];
    for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
      const stub = env.KARAOKE_ATTEMPT.getByName(`install-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (instance, state) => {
        useFixtureIdentity(instance, state, objectId);
        const entrypoint = new KaraokeResetOperatorEntrypoint(createExecutionContext(), {
          ...bindings,
          KARAOKE_ATTEMPT: {
            idFromString(value) {
              if (value !== objectId) throw new Error("unexpected_target");
              return state.id;
            },
            get: () => instance,
          },
        });
        await expect(entrypoint.apply("invalid", command(objectId))).rejects.toThrow();
        await state.storage.setAlarm(Date.now() + 60_000);
        const receipt = await entrypoint.apply(token, command(objectId));
        receipts.push(receipt);
        expect(receipt.initial.alarm).not.toBeNull();
        expect(await state.storage.get(KARAOKE_RESET_MARKER_KEY)).toMatchObject({
          objectId,
          state: "active",
        });
        expect(await state.storage.get("karaoke:staging-reset-receipt:v1")).toEqual(receipt);
        await instance.alarm();
        expect(await instance.redriveFinalization()).toEqual({ outcome: "fenced", rearmed: [] });
        expect(await state.storage.getAlarm()).toBeNull();
        const replay = await entrypoint.apply(token, command(objectId));
        expect(replay.initial).toEqual(receipt.initial);
        expect((await entrypoint.apply(token, command(objectId, "retired"))).state).toBe("retired");
        await expect(entrypoint.apply(token, command(objectId))).rejects.toThrow(
          "karaoke_reset_retired",
        );
      });
    }
    verifyKaraokeResetReceipts(receipts, "active");
    const fresh = env.KARAOKE_ATTEMPT.newUniqueId();
    await runInDurableObject(env.KARAOKE_ATTEMPT.get(fresh), async (instance, state) => {
      await expect(
        instance.applyReset(token, command(KARAOKE_RESET_OBJECT_IDS[0])),
      ).rejects.toThrow();
      expect(await state.storage.get(KARAOKE_RESET_MARKER_KEY)).toBeUndefined();
    });
  });

  it("denies after reconstruction with enablement absent and refuses lost in-flight accounting", async () => {
    const id = KARAOKE_RESET_OBJECT_IDS[0];
    const stub = env.KARAOKE_ATTEMPT.getByName(`reconstruct-${crypto.randomUUID()}`);
    const token = await assertion();
    await runInDurableObject(stub, async (instance, state) => {
      useFixtureIdentity(instance, state, id);
      await instance.applyReset(token, command(id));
      await state.storage.put("karaoke:staging-reset-unsettled:v1", true);
      const calls = { pg: 0, r2: 0 };
      const object = new KaraokeAttemptDO(state, {
        ...bindings,
        get CONTROL_PLANE(): never {
          calls.pg += 1;
          throw new Error("unexpected_pg");
        },
        get LEARNER_AUDIO(): never {
          calls.r2 += 1;
          throw new Error("unexpected_r2");
        },
      });
      await state.blockConcurrencyWhile(async () => {});
      useFixtureIdentity(object, state, id);
      expect((await object.applyReset(token, command(id))).quiescenceEstablished).toBe(false);
      const unconfigured = new KaraokeAttemptDO(state, {
        get CONTROL_PLANE(): never {
          calls.pg += 1;
          throw new Error("unexpected_pg");
        },
        get LEARNER_AUDIO(): never {
          calls.r2 += 1;
          throw new Error("unexpected_r2");
        },
      });
      await state.blockConcurrencyWhile(async () => {});
      await unconfigured.alarm();
      expect(await unconfigured.redriveFinalization()).toEqual({ outcome: "fenced", rearmed: [] });
      expect(calls).toEqual({ pg: 0, r2: 0 });
    });
  });

  it("retains the installed marker and reports incomplete evidence when cancellation fails", async () => {
    const stub = env.KARAOKE_ATTEMPT.getByName(`cancel-${crypto.randomUUID()}`);
    const token = await assertion();
    await runInDurableObject(stub, async (instance, state) => {
      const id = KARAOKE_RESET_OBJECT_IDS[0];
      useFixtureIdentity(instance, state, id, { failCancellation: true });
      await state.storage.setAlarm(Date.now() + 60_000);
      const receipt = await instance.applyReset(token, command(id));
      expect(receipt.cancellationSucceeded).toBe(false);
      expect(receipt.current.alarm).not.toBeNull();
      expect(await state.storage.get(KARAOKE_RESET_MARKER_KEY)).toMatchObject({ state: "active" });
      expect(await instance.redriveFinalization()).toEqual({ outcome: "fenced", rearmed: [] });
      useFixtureIdentity(instance, state, id);
      expect((await instance.applyReset(token, command(id))).cancellationSucceeded).toBe(true);
    });
  });

  it("waits for a pre-fence redrive and returns the terminal fenced result", async () => {
    const stub = env.KARAOKE_ATTEMPT.getByName(`redrive-${crypto.randomUUID()}`);
    const token = await assertion();
    await runInDurableObject(stub, async (instance, state) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const persisted = Promise.withResolvers<void>();
      const id = KARAOKE_RESET_OBJECT_IDS[0];
      useFixtureIdentity(instance, state, id, {
        persisted: () => persisted.resolve(),
        alarmWritten: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      state.storage.sql.exec(
        "INSERT INTO karaoke_session (id,authority_json,snapshot_json,server_sequence) VALUES (1,'{}','{}',0)",
      );
      const redrive = instance.redriveFinalization();
      await entered.promise;
      let completed = false;
      const installation = instance.applyReset(token, command(id)).then((receipt) => {
        completed = true;
        return receipt;
      });
      await persisted.promise;
      expect(completed).toBe(false);
      release.resolve();
      expect(await redrive).toEqual({ outcome: "fenced", rearmed: [] });
      const receipt = await installation;
      expect(receipt.quiescenceEstablished).toBe(true);
      expect(receipt.current.alarm).toBeNull();
    });
  });

  it("waits for in-flight multipart creation and records its late upload ID without uploading", async () => {
    const stub = env.KARAOKE_ATTEMPT.getByName(`drain-${crypto.randomUUID()}`);
    const token = await assertion();
    await runInDurableObject(stub, async (_instance, state) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const persisted = Promise.withResolvers<void>();
      const calls = { pg: 0, part: 0, complete: 0, abort: 0, get: 0 };
      const object = new KaraokeAttemptDO(state, {
        ...bindings,
        get CONTROL_PLANE(): never {
          calls.pg += 1;
          throw new Error("unexpected_pg");
        },
        LEARNER_AUDIO: {
          async createMultipartUpload() {
            entered.resolve();
            await release.promise;
            return {
              uploadId: "late-upload-id",
              async uploadPart() {
                calls.part += 1;
                return { partNumber: 1, etag: "unexpected" };
              },
              async complete() {
                calls.complete += 1;
              },
              async abort() {
                calls.abort += 1;
              },
            };
          },
          resumeMultipartUpload(): never {
            throw new Error("unexpected_resume");
          },
          async get() {
            calls.get += 1;
            return null;
          },
        },
      });
      await state.blockConcurrencyWhile(async () => {});
      const id = KARAOKE_RESET_OBJECT_IDS[0];
      useFixtureIdentity(object, state, id, { persisted: () => persisted.resolve() });
      state.storage.sql.exec(`INSERT INTO karaoke_archive
        (id,upload_id,object_key,next_part,parts_json,byte_size,duration_ms,state)
        VALUES (1,NULL,'karaoke/fixture/attempt.pcm',1,'[]',2,1,'pending')`);
      state.storage.sql.exec(
        "INSERT INTO karaoke_audio_chunk VALUES (1,?,2)",
        new Uint8Array([0, 0]).buffer,
      );
      const finish = Reflect.get(object, "finishArchive");
      if (typeof finish !== "function") throw new Error("missing_archive_producer");
      const rejected = expect(finish.call(object)).rejects.toThrow("karaoke_reset_fenced");
      await entered.promise;
      let completed = false;
      const installation = object.applyReset(token, command(id)).then((receipt) => {
        completed = true;
        return receipt;
      });
      await persisted.promise;
      expect(completed).toBe(false);
      release.resolve();
      await rejected;
      const receipt = await installation;
      expect(receipt.quiescenceEstablished).toBe(true);
      expect(receipt.initial.uploadId).toBeNull();
      expect(receipt.current.uploadId).toBe("late-upload-id");
      expect(calls).toEqual({ pg: 0, part: 0, complete: 0, abort: 0, get: 0 });
    });
  });
});
