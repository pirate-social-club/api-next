// Future admitted source fixture: actual default factory, four real LOGINs,
// real native263, real cookie/decoder/transport; no metadata rewrite or overlay.
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { guestParticipationRegistry } from "@pirate/contracts";
import { Schema } from "effect";
import { bounded } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import {
  type ReadinessFixture,
  readinessFixture,
} from "../../../packages/platform-cf/src/guest-study-managed-readiness.pg-fixture.ts";
import { makeControlPlaneIdentityStore } from "../../../packages/platform-cf/src/identity-repository.ts";
import {
  disclosure,
  editFixture,
  policy,
} from "../../../packages/platform-cf/src/owner-study-starter.pg-fixture.ts";
import { makeSessionCrypto } from "../../../packages/platform-cf/src/session-crypto.ts";
import { makeRs256SessionTokenVerifier } from "../../../packages/platform-cf/src/session-tokens.ts";
import { ELEVENLABS_STUDY_BATCH_ENDPOINT } from "../../../packages/platform-cf/src/study-spoken-audio.ts";
import { workerBackground } from "../../../packages/platform-cf/src/worker-background.ts";
import { makeHttpWorkerTestBindings } from "./composition.test-fixtures.ts";
import {
  guestAccountingNames,
  guestLearningNames,
} from "./guest-authority-controller-composition.ts";
import {
  type GuestStudyManagedBindings,
  makeDefaultGuestStudyManagedRuntime,
} from "./guest-study-managed-bindings.ts";
import { Browser, json, startBody } from "./guest-study-private-journey.pg-fixture.ts";
import {
  exactOrigin,
  protectedOrigin,
  servingHnsHarness,
} from "./guest-study-serving.hns.fixture.ts";
import {
  type GuestStudyServingName,
  makeGuestStudyServingComposition,
} from "./guest-study-serving-composition.ts";
import { createHttpWorker } from "./transport.ts";

export { Browser, disclosure, json, policy, startBody };
export const ordinaryOrigin = "https://community.example";
export const source = { communityId: "study-community", postId: "study-post" };
export const implementedSource =
  guestLearningNames.every(
    (name) => guestParticipationRegistry[name].implementation !== "disabled",
  ) &&
  guestAccountingNames.every(
    (name) => guestParticipationRegistry[name].implementation === "disabled",
  );
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const Snapshot = Schema.Struct({
  accounts: Schema.Int,
  personas: Schema.Int,
  memberships: Schema.Int,
  guests: Schema.Int,
  sessions: Schema.Int,
  calls: Schema.Int,
  checkpoints: Schema.Int,
  uploads: Schema.Int,
});
export type RequestOptions = Readonly<{
  path?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  audio?: Uint8Array;
  extraHeaders?: Readonly<Record<string, string>>;
}>;
export async function defaultWorkerFixture(
  use: (
    f: Omit<ReadinessFixture, "bindings"> & {
      bindings: GuestStudyManagedBindings;
      ordinaryBindings: Awaited<ReturnType<typeof makeHttpWorkerTestBindings>>;
      makeWorker: (configuration?: string | null) => Promise<ReturnType<typeof createHttpWorker>>;
      makeHns: (
        configuration?: string | null,
      ) => Promise<Awaited<ReturnType<typeof servingHnsHarness>>>;
      request: (
        worker: ReturnType<typeof createHttpWorker>,
        browser: Browser,
        name: GuestStudyServingName,
        options?: RequestOptions,
      ) => Promise<Response>;
      forwarded: (
        hns: Awaited<ReturnType<typeof servingHnsHarness>>,
        browser: Browser,
        name: GuestStudyServingName,
        options?: RequestOptions,
      ) => Promise<Response>;
      snapshot: () => Promise<Schema.Schema.Type<typeof Snapshot>>;
      objects: Map<string, Uint8Array>;
      providerCalls: () => number;
      transcript: (value: string) => void;
      taskFetch: (
        worker: ReturnType<typeof createHttpWorker>,
        request: Request,
      ) => Promise<Response>;
    },
  ) => Promise<void>,
) {
  if (!implementedSource)
    throw new Error(
      "Canonical positive journey requires actual admitted 16 declarations and five disabled accounting declarations",
    );
  await readinessFixture(
    async (f) => {
      expect(f.schema).toBe("api_next");
      // Reuse genuine maintained song rows; repair the preparedness-only source
      // profile of the Account/TG fixture. No Guest actor, session or CP row is seeded.
      const lyrics = f.lines.join("\n"),
        lyricsHash = digest(lyrics);
      await editFixture(
        f.admin,
        `INSERT INTO media_song_lyrics_revisions(submission_id,community_id,actor_user_id,author_persona_id,
      operation_id,lyrics_revision,creation_revision,audio_revision,canonical_audio_sha256,lyrics_text,lyrics_sha256,provenance)
      VALUES('study-submission','study-community','study-account','study-persona','study-operation',1,2,1,$1,$2,$3,'pasted')`,
        ["2".repeat(64), lyrics, lyricsHash],
      );
      await editFixture(
        f.admin,
        "UPDATE study_language_profiles SET source_hash=$1,request_hash=$1 WHERE community_id='study-community' AND post_id='study-post'",
        [lyricsHash],
      );
      const retained: Promise<PromiseSettledResult<unknown>>[] = [],
        requests: Promise<PromiseSettledResult<Response>>[] = [],
        objects = new Map<string, Uint8Array>();
      const observe = <A>(original: Promise<A>): Promise<PromiseSettledResult<A>> =>
        original.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ status: "rejected" as const, reason }),
        );
      // Observe immediately, but callers and waitUntil keep the ORIGINAL promise.
      // The observation never fabricates fulfillment or replaces settlement.
      const retain = (original: Promise<unknown>) => {
        retained.push(observe(original));
      };
      let requestRegistrationClosed = false,
        requestsSettled = false,
        retainedSettled = false;
      let resolveRequestsSettled: () => void = () => {};
      const requestsSettledSignal = new Promise<void>((resolve) => {
        resolveRequestsSettled = resolve;
      });
      let primaryFailure: unknown,
        primaryFailed = false;
      const cleanupFailures: unknown[] = [];
      let providerCalls = 0,
        transcript = f.lines[0] ?? "I can love you";
      const outsideSql = async () =>
        expect(
          (
            await f.admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND state IN ('active','idle in transaction')",
              [f.principals.learning.role],
            )
          ).rows,
        ).toEqual([{ n: 0 }]);
      const bucket = {
        put: async (key: string, bytes: Uint8Array) => {
          await outsideSql();
          objects.set(key, new Uint8Array(bytes));
          return { size: bytes.byteLength };
        },
        delete: async (keys: string | string[]) => {
          await outsideSql();
          for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
        },
      };
      const originalFetch = globalThis.fetch;
      // External boundary only. SDK construction still selects actual ElevenLabs
      // transcriber/global fetch, never an injected provider result or CP/store.
      const providerFetch: typeof globalThis.fetch = Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
          const [input] = args;
          const url = input instanceof Request ? input.url : String(input);
          if (url !== ELEVENLABS_STUDY_BATCH_ENDPOINT)
            throw new Error("Unexpected owned external I/O");
          await outsideSql();
          providerCalls++;
          return Response.json({
            text: transcript,
            language_code: "en",
            language_probability: 0.99,
          });
        },
        originalFetch,
      );
      globalThis.fetch = providerFetch;
      try {
        const ordinaryBindings = await makeHttpWorkerTestBindings(f.runtimeUrl);
        const required = (value: string | undefined) => {
          if (value === undefined) throw new Error("Owned session key configuration unavailable");
          return value;
        };
        const sessionCrypto = await makeSessionCrypto({
          privateKeyPem: required(ordinaryBindings.PIRATE_APP_JWT_PRIVATE_KEY),
          publicKeyPem: required(ordinaryBindings.PIRATE_APP_JWT_PUBLIC_KEY),
          issuer: required(ordinaryBindings.PIRATE_APP_JWT_ISSUER),
          audience: required(ordinaryBindings.PIRATE_APP_JWT_AUDIENCE),
          defaultScope: required(ordinaryBindings.PIRATE_APP_JWT_SCOPE),
          defaultTtlSeconds: 300,
        });
        const bindings: GuestStudyManagedBindings = {
          GUEST_STUDY_SERVING_ENABLED: "true",
          GUEST_STUDY_PRODUCT_ORIGIN: ordinaryOrigin,
          GUEST_STUDY_RUNTIME_CONFIGURATION: JSON.stringify({ policy, disclosure }),
          GUEST_STUDY_PUBLIC_READ: { connectionString: f.principals.publicRead.url },
          GUEST_STUDY_CONTROLLED_LEARNING: { connectionString: f.principals.learning.url },
          GUEST_STUDY_CRON: { connectionString: f.principals.cron.url },
          GUEST_STUDY_READINESS_OBSERVER: { connectionString: f.principals.observer.url },
          LEARNER_AUDIO: bucket,
          ELEVENLABS_API_KEY: "owned-disposable-provider-fixture",
          STUDY_SPOKEN_RERECORD_ENABLED: "true",
        };
        const compose = async (configuration: string | null | undefined) => {
          const selected =
            configuration === null
              ? {
                  ...bindings,
                  GUEST_STUDY_RUNTIME_CONFIGURATION: undefined,
                  ELEVENLABS_API_KEY: undefined,
                }
              : {
                  ...bindings,
                  ...(configuration === undefined
                    ? {}
                    : { GUEST_STUDY_RUNTIME_CONFIGURATION: configuration }),
                };
          // Avoid explicitly assigning undefined optional fields under exact TS.
          const {
            GUEST_STUDY_RUNTIME_CONFIGURATION: currentConfiguration,
            ELEVENLABS_API_KEY: currentKey,
            ...base
          } = selected;
          const actual = {
            ...base,
            ...(currentConfiguration === undefined
              ? {}
              : { GUEST_STUDY_RUNTIME_CONFIGURATION: currentConfiguration }),
            ...(currentKey === undefined ? {} : { ELEVENLABS_API_KEY: currentKey }),
          };
          const managed = makeDefaultGuestStudyManagedRuntime(actual, "test");
          if (managed === null)
            throw new Error("Admitted source default factory unexpectedly inert");
          const guestStudy = await makeGuestStudyServingComposition({
            managed,
            workerLearnerAudioBinding: bucket,
            environment: "test",
            enabledBinding: "true",
            ...(currentConfiguration === undefined
              ? {}
              : { configurationBinding: currentConfiguration }),
            accountVerifier: makeRs256SessionTokenVerifier(
              sessionCrypto,
              makeControlPlaneIdentityStore(managed.learning),
            ),
            ordinarySessionScope: sessionCrypto.defaultScope,
            hnsProtectedIngressOrigin: protectedOrigin,
          });
          if (guestStudy === null)
            throw new Error("Admitted source serving graph unexpectedly inert");
          return guestStudy;
        };
        const taskFetch = (worker: ReturnType<typeof createHttpWorker>, request: Request) => {
          if (requestRegistrationClosed)
            throw new Error("Owned Worker request registration is closed");
          const response = Promise.resolve(
            workerBackground.run(retain, () => worker.fetch(request)),
          );
          requests.push(observe(response));
          return response;
        };
        const locations = (name: GuestStudyServingName, input: RequestOptions) => {
          const definition = guestParticipationRegistry[name];
          let path: string = definition.path;
          for (const [key, value] of Object.entries(input.path ?? {}))
            path = path.replace(`:${key}`, encodeURIComponent(value));
          if (path.includes(":")) throw new Error("Exact owned request locators required");
          const query = new URLSearchParams(input.query ?? {});
          const bytes =
            input.audio === undefined
              ? input.body === undefined
                ? new Uint8Array()
                : new TextEncoder().encode(JSON.stringify(input.body))
              : new Uint8Array(input.audio);
          return { definition, path: `${path}${query.size === 0 ? "" : `?${query}`}`, bytes };
        };
        const headers = (
          browser: Browser,
          name: GuestStudyServingName,
          input: RequestOptions,
          origin: string,
        ) => {
          const result = browser.headers(guestParticipationRegistry[name].method !== "GET");
          if (result.has("origin")) result.set("origin", origin);
          for (const [key, value] of Object.entries(input.extraHeaders ?? {}))
            result.set(key, value);
          if (input.body !== undefined) result.set("content-type", "application/json");
          return result;
        };
        await use({
          ...f,
          bindings,
          ordinaryBindings,
          objects,
          providerCalls: () => providerCalls,
          transcript: (value) => {
            transcript = value;
          },
          taskFetch,
          makeWorker: async (configuration) =>
            createHttpWorker({
              config: { corsOrigin: ordinaryOrigin },
              guestStudy: await compose(configuration),
            }),
          makeHns: async (configuration) =>
            servingHnsHarness(await compose(configuration), source.communityId),
          request: async (worker, browser, name, input = {}) => {
            const { definition, path, bytes } = locations(name, input);
            return taskFetch(
              worker,
              new Request(`${ordinaryOrigin}${path}`, {
                method: definition.method,
                headers: headers(browser, name, input, ordinaryOrigin),
                ...(definition.method === "GET" || bytes.byteLength === 0 ? {} : { body: bytes }),
              }),
            );
          },
          forwarded: async (hns, browser, name, input = {}) => {
            const { definition, path, bytes } = locations(name, input);
            if (definition.method !== "GET" && definition.method !== "POST")
              throw new Error("Owned forwarded fixture supports exact GET/POST only");
            return taskFetch(
              hns.worker,
              await hns.signed(`/api${path}`, definition.method, undefined, {
                headers: headers(browser, name, input, exactOrigin),
                bodyBytes: bytes,
              }),
            );
          },
          snapshot: async () =>
            Schema.decodeUnknownSync(Snapshot, { onExcessProperty: "error" })(
              (
                await f.admin.query(`SELECT
          (SELECT count(*)::int FROM users) AS accounts,(SELECT count(*)::int FROM personas) AS personas,
          (SELECT count(*)::int FROM community_memberships) AS memberships,(SELECT count(*)::int FROM participation_owners WHERE kind='guest') AS guests,
          (SELECT count(*)::int FROM study_sessions_v2 WHERE participation_owner_kind='guest') AS sessions,
          (SELECT count(*)::int FROM guest_resource_provider_calls) AS calls,(SELECT count(*)::int FROM guest_study_spoken_checkpoints) AS checkpoints,
          (SELECT count(*)::int FROM learner_audio_upload_attempts) AS uploads`)
              ).rows[0],
            ),
        });
      } catch (error) {
        primaryFailed = true;
        primaryFailure = error;
      } finally {
        requestRegistrationClosed = true;
        const drainRequests = async () => {
          const results = await Promise.all(requests);
          requestsSettled = true;
          resolveRequestsSettled();
          return results;
        };
        const drainRetained = async () => {
          // A running request may still register work. Do not credit one early
          // snapshot; wait for genuine request settlement, then repeat until the
          // actual retained registration count stabilizes after each settled batch.
          let checked = 0;
          const results: PromiseSettledResult<unknown>[] = [];
          for (;;) {
            const boundary = retained.length;
            results.push(...(await Promise.all(retained.slice(checked, boundary))));
            checked = boundary;
            if (!requestsSettled) await requestsSettledSignal;
            await Promise.resolve();
            if (requestRegistrationClosed && requestsSettled && checked === retained.length) {
              retainedSettled = true;
              return results;
            }
          }
        };
        try {
          // Start BOTH finite drains before awaiting either. Each observer itself
          // fulfills with original settlement metadata; inspect every nested result.
          const requestDrain = bounded(drainRequests(), "canonical Worker requests drain", 8000);
          const retainedDrain = bounded(
            drainRetained(),
            "canonical Worker retained tasks drain",
            8000,
          );
          const drains = await Promise.allSettled([requestDrain, retainedDrain]);
          let unresolvedDrain = false;
          for (const drain of drains) {
            if (drain.status === "rejected") {
              cleanupFailures.push(drain.reason);
              unresolvedDrain = true;
            } else
              for (const result of drain.value)
                if (result.status === "rejected") cleanupFailures.push(result.reason);
          }
          if (unresolvedDrain || !requestsSettled || !retainedSettled) {
            // TEST-ONLY refusal latch derived from actual unresolved drains. Nested
            // fixture teardown must keep grants/logins/namespace until the owned
            // application process is killed and PostgreSQL is stopped/removed.
            f.deferDestructiveCleanup();
            process.stdout.write(
              `${JSON.stringify({
                fixture: "canonical-guest-worker-drain",
                requestsSettled,
                retainedSettled,
                retainedOwnershipAtDrainDeadline: "unknown",
                destructiveCleanup: "deferred",
                physicalBarrierRequired: true,
              })}\n`,
            );
          }
        } catch (error) {
          cleanupFailures.push(error);
          f.deferDestructiveCleanup();
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
      // Preserve the original case failure plus every cleanup failure without a
      // throw from finally (and without claiming unresolved work has drained).
      if (cleanupFailures.length > 0)
        throw new AggregateError(
          primaryFailed ? [primaryFailure, ...cleanupFailures] : cleanupFailures,
          "Owned canonical Worker cleanup incomplete",
        );
      if (primaryFailed) throw primaryFailure;
    },
    { schema: "api_next" },
  );
}
