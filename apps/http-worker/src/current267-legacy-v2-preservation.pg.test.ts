// Genuine default factory/native267 preservation: Guest NEW flag is not ordinary V2 authority.
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AddMegapotPoolLeg,
  StartStudySessionV2,
  StudyAnswerResultV2,
  StudySessionV2,
} from "@pirate/contracts";
import { Schema } from "effect";
import { bounded } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import {
  encodeMegapotJackpotTicketNft,
  encodeMegapotJackpotUsdc,
} from "../../../packages/platform-cf/src/megapot-v2.ts";
import { ownerFinancialGuestStudyReadinessSource } from "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts";
import {
  address,
  bytecode,
  observed,
  prepareCreatorSource,
} from "../../../packages/platform-cf/src/owner-megapot-creator.pg-fixture.ts";
import { pgUrl } from "../../../packages/platform-cf/src/owner-study-starter.pg-fixture.ts";
import { ELEVENLABS_STUDY_BATCH_ENDPOINT } from "../../../packages/platform-cf/src/study-spoken-audio.ts";
import {
  defaultWorkerFixture,
  ordinaryOrigin,
  source,
} from "./guest-study-default-worker.pg-fixture.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { createProductionHttpWorker } = await import("./composition.ts");
const pgTest = pgUrl ? test : test.skip;
const decode = <S extends Schema.ConstraintDecoder<unknown>>(s: S, v: unknown): S["Type"] =>
  Schema.decodeUnknownSync(s, { onExcessProperty: "error" })(v);
pgTest(
  "current267 learning=true and Guest NEW=false retain ordinary V2 creator, Study start/CP/qualification and exact replay",
  async () => {
    const raw = await readFile(
      new URL(
        "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "0004224eb102647f822690b1be630962a696ee312375af91d44ccbe4ce89cfca",
    );
    const adopted = ownerFinancialGuestStudyReadinessSource;
    if (adopted === null) throw new Error("Actual compiled current267 source required");
    expect(adopted.candidate.ledger).toHaveLength(267);
    expect(adopted.candidate.native_function_bodies).toHaveLength(423);
    expect(adopted.candidate.profiles.ordinaryAccount.functions).toHaveLength(124);
    await defaultWorkerFixture(
      async (f) => {
        const ordinary = f.principals.ordinaryAccount;
        if (ordinary === undefined)
          throw new Error("Verified fifth actual restricted LOGIN required");
        const prepared = await prepareCreatorSource(
          {
            admin: f.admin,
            adminRuntime: f.adminRuntime,
            ordinaryRuntime: ordinary.runtime(),
          },
          "current267-learning-v2",
        );
        const bindings = {
          ...f.ordinaryBindings,
          ...f.bindings,
          MEGAPOT_REWARDS_ENABLED: "true",
          CORS_ORIGIN: ordinaryOrigin,
          API_NEXT_ENV: "development",
        };
        expect(bindings.GUEST_STUDY_SERVING_ENABLED).toBe("true");
        expect(bindings.GUEST_STUDY_REWARDS_ENABLED).toBe("false");
        expect(new Set(Object.values(f.principals).map((p) => p.role)).size).toBe(5);
        const originalFetch = globalThis.fetch;
        let calls = 0;
        const Rpc = Schema.Struct({
          jsonrpc: Schema.Literal("2.0"),
          id: Schema.String,
          method: Schema.String,
          params: Schema.Array(Schema.Unknown),
        });
        // Same accepted attestation-only six-call boundary as the existing creator
        // suite. Spoken requests retain the maintained real invoking SDK/engine.
        const synthetic: typeof globalThis.fetch = Object.assign(
          async (...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
            const [input, init] = args;
            const url = input instanceof Request ? input.url : String(input);
            if (url === ELEVENLABS_STUDY_BATCH_ENDPOINT) return originalFetch(...args);
            if (url !== new URL(decode(Schema.String, bindings.MEGAPOT_V2_RPC_URL)).toString())
              throw new Error("Unexpected owned external request");
            const request = decode(Rpc, JSON.parse(decode(Schema.String, init?.body)));
            calls++;
            let result: string;
            if (request.method === "eth_chainId") result = "0x14a34";
            else if (request.method === "eth_getCode") {
              const target = decode(Schema.String, request.params[0]);
              if (target === address("2")) result = bytecode.jackpot;
              else if (target === address("3")) result = bytecode.ticket;
              else if (target === address("1")) result = bytecode.usdc;
              else throw new Error("Foreign owned code request");
            } else if (request.method === "eth_call") {
              const call = decode(
                Schema.Struct({ to: Schema.String, data: Schema.String }),
                request.params[0],
              );
              if (call.to !== address("2")) throw new Error("Foreign owned contract request");
              if (call.data === encodeMegapotJackpotTicketNft())
                result = `0x${address("3").slice(2).padStart(64, "0")}`;
              else if (call.data === encodeMegapotJackpotUsdc())
                result = `0x${address("1").slice(2).padStart(64, "0")}`;
              else throw new Error("Unexpected owned attestation selector");
            } else throw new Error("Unexpected owned RPC method");
            return Response.json({ jsonrpc: "2.0", id: request.id, result });
          },
          originalFetch,
        );
        let failed = false,
          primary: unknown;
        const cleanup: unknown[] = [];
        const settlements: Array<
          Promise<ReturnType<typeof observed<Response>> extends Promise<infer A> ? A : never>
        > = [];
        try {
          globalThis.fetch = synthetic;
          const worker = await createProductionHttpWorker(bindings);
          const token = await f.ordinarySessionToken();
          const headers = (contentType: string) =>
            new Headers({
              cookie: `__Host-pirate_session=${token}; __Host-pirate_csrf=owned-current267-v2-csrf`,
              origin: ordinaryOrigin,
              "x-csrf-token": "owned-current267-v2-csrf",
              "content-type": contentType,
            });
          const request = async (
            path: string,
            body: unknown,
            extra: Readonly<Record<string, string>> = {},
            audio?: Uint8Array,
          ) => {
            const h = headers(audio === undefined ? "application/json" : "audio/webm");
            for (const [key, value] of Object.entries(extra)) h.set(key, value);
            const pending = f.taskFetch(
              worker,
              new Request(`${ordinaryOrigin}${path}`, {
                method: "POST",
                headers: h,
                body: audio === undefined ? JSON.stringify(body) : audio,
              }),
            );
            settlements.push(observed(pending));
            return bounded(pending, "current267 ordinary V2 request", 8000);
          };
          const created = await request(
            `/reward-offers/${encodeURIComponent(prepared.offerId)}/megapot-pool-legs`,
            {
              persona_id: prepared.personaId,
              idempotency_key: "current267-default-v2-leg",
              funding_amount_atomic: "100000",
              max_ticket_price_atomic: "10000",
              entry_cutoff_seconds: 300,
              eligible_activities: ["study"],
              expected_qualification_policy_versions: { study: "study_session_first_pass_v2@1" },
              min_score_bps: 7000,
              empty_pool_policy: "no_purchase",
              fallback_payout_persona_id: null,
              fallback_disclosure_acknowledged: false,
            },
          );
          expect(created.status).toBe(201);
          const leg = decode(AddMegapotPoolLeg.response, await created.json());
          expect(leg.replayed).toBe(false);
          expect(
            (
              await f.admin.query(
                "SELECT beneficiary_version FROM song_reward_offer_legs WHERE leg_id=$1",
                [leg.leg.leg_id],
              )
            ).rows,
          ).toEqual([{ beneficiary_version: 2 }]);
          expect(calls).toBe(6);
          const startBody = decode(StartStudySessionV2.request.body, {
            idempotency_key: "current267-ordinary-v2-start",
            persona_id: prepared.personaId,
            target_language: null,
            learner_band: null,
            timezone: "UTC",
          });
          const startPath = `/communities/${source.communityId}/posts/${source.postId}/study/v2/sessions`;
          const started = await request(startPath, startBody);
          expect(started.status).toBe(201);
          let session = decode(StudySessionV2, await started.json());
          const startedSession = session;
          const replay = await request(startPath, startBody);
          expect(replay.status).toBe(201);
          expect(decode(StudySessionV2, await replay.json())).toEqual(startedSession);
          let count = 0;
          while (session.status === "active") {
            if (++count > session.items.length)
              throw new Error("Genuine V2 lesson did not advance within its own source items");
            const current = session.lesson.current;
            if (current === null) throw new Error("Actual legacy V2 current item required");
            const item = session.items.find(
              (row) => row.session_item_id === current.session_item_id,
            );
            if (item === undefined || item.presentation.kind !== "say_it_back")
              throw new Error("Actual source read-aloud item required");
            f.transcript(item.presentation.reference_text);
            const answerPath = `/communities/${source.communityId}/study/v2/sessions/${session.session_id}/items/${item.session_item_id}/answers`;
            const extra = {
              "idempotency-key": `current267-v2-answer-${count}`,
              "x-study-attempt-number": "1",
              "x-audio-duration-ms": "1000",
            };
            const audio = new Uint8Array([7, 11, 19]);
            const answered = await request(answerPath, undefined, extra, audio);
            expect(answered.status).toBe(200);
            const accepted = decode(StudyAnswerResultV2, await answered.json());
            expect(accepted.outcome).toBe("correct");
            const repeated = await request(answerPath, undefined, extra, audio);
            expect(repeated.status).toBe(200);
            expect(decode(StudyAnswerResultV2, await repeated.json())).toEqual(accepted);
            session = accepted.session;
          }
          expect(session.status).toBe("completed");
          expect(session.progress.first_pass_correct).toBe(session.items.length);
          expect(
            (
              await f.admin.query(
                "SELECT account_id,persona_id,activity_key,qualification_policy_version_id FROM activity_qualifications WHERE study_session_id=$1",
                [session.session_id],
              )
            ).rows,
          ).toEqual([
            {
              account_id: "study-account",
              persona_id: prepared.personaId,
              activity_key: "study",
              qualification_policy_version_id: "study_session_first_pass_v2@1",
            },
          ]);
          expect(
            (
              await f.admin.query(
                "SELECT count(*)::integer AS guest_owners FROM participation_owners WHERE kind='guest'",
              )
            ).rows,
          ).toEqual([{ guest_owners: 0 }]);
          expect(f.providerCalls()).toBe(session.items.length);
          expect(f.objects.size).toBe(session.items.length);
        } catch (error) {
          failed = true;
          primary = error;
        } finally {
          try {
            await bounded(
              Promise.all(settlements),
              "current267 V2 unconditional request drain",
              10000,
            );
          } catch (error) {
            cleanup.push(error);
          }
          try {
            globalThis.fetch = originalFetch;
          } catch (error) {
            cleanup.push(error);
          }
        }
        if (failed || cleanup.length)
          throw new AggregateError(
            [...(failed ? [primary] : []), ...cleanup],
            "Current267 V2 preservation or owned drain failed",
          );
      },
      adopted,
      false,
    );
  },
  120000,
);
