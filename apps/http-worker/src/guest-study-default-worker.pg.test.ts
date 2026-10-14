// Current managed267 Worker practice-only regression with NEW rewards disabled in the owned fixture.
import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  GuestAuthorityV1,
  GuestLearnerAudioDeletionV1,
  GuestLearningRetentionV1,
  GuestStudyAnswerResultV1,
  GuestStudyPreparedContentV2,
  GuestStudySessionV1,
} from "@pirate/contracts";
import { Schema } from "effect";
import { pgUrl } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import { ownerFinancialGuestStudyReadinessSource } from "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts";
import {
  Browser,
  defaultWorkerFixture,
  disclosure,
  financialImplementedSource,
  json,
  ordinaryOrigin,
  type RequestOptions,
  source,
  startBody,
} from "./guest-study-default-worker.pg-fixture.ts";
import { createHttpWorker } from "./transport.ts";

// Same Node test-platform stand-in as maintained production Worker suites.
// It supplies no authority, handler, DB, cryptography, readiness or provider result.
mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { createProductionHttpWorker } = await import("./composition.ts");
const suite = pgUrl ? describe : describe.skip;
if (pgUrl && !financialImplementedSource)
  throw new Error(
    "Current native267 Worker regression requires actual implemented learning/accounting source",
  );
async function currentNativeSource() {
  const raw = await readFile(
    new URL(
      "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts",
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    "0004224eb102647f822690b1be630962a696ee312375af91d44ccbe4ce89cfca",
  );
  const value = ownerFinancialGuestStudyReadinessSource;
  if (value === null) throw new Error("Actual compiled current financial native source required");
  expect(value.candidate.ledger).toHaveLength(267);
  expect(value.candidate.native_function_bodies).toHaveLength(423);
  expect(value.candidate.profiles.ordinaryAccount.functions).toHaveLength(124);
  return value;
}
async function body<S extends Schema.ConstraintDecoder<unknown>>(
  response: Response,
  schema: S,
): Promise<S["Type"]> {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(await json(response));
}
type Call = (
  name: "GetGuestAuthorityV1" | "IssueGuestBootstrapV1" | "ConfirmGuestBootstrapV1",
  input?: RequestOptions,
) => Promise<Response>;
async function bootstrap(browser: Browser, call: Call, key: string) {
  const discover = await call("GetGuestAuthorityV1");
  expect(discover.status).toBe(200);
  browser.apply(discover);
  expect((await body(discover, GuestAuthorityV1)).state).toBe("absent");
  const issued = await call("IssueGuestBootstrapV1", { body: { idempotency_key: key } });
  expect(issued.status).toBe(200);
  browser.apply(issued);
  const selected = (await body(issued, GuestAuthorityV1)).selected;
  if (selected === null) throw new Error("Real pending authority required");
  browser.selected = selected.credential_id;
  const confirm = await call("ConfirmGuestBootstrapV1", {
    body: { credential_id: selected.credential_id, expected_owner_id: selected.owner_id },
  });
  expect(confirm.status).toBe(200);
  expect(confirm.headers.getSetCookie()).toHaveLength(0);
  browser.apply(confirm);
  expect((await body(confirm, GuestAuthorityV1)).state).toBe("confirmed");
  return selected;
}
suite("canonical default managed Guest Worker/native/HNS journey", () => {
  test("default bindings and concrete readiness serve account-free prepared/start/spoken, config-free exact CP replay and fenced deletion", async () => {
    await defaultWorkerFixture(
      async (f) => {
        const before = await f.snapshot();
        let publicPreparedCalls = 0;
        const uncomposed = createHttpWorker({
          handlers: {
            GetPublicGuestStudyPreparedContentV2: async () => {
              publicPreparedCalls++;
              throw new Error("Ordinary public handler must not bypass managed Guest readiness");
            },
          },
        });
        const refusedPrepared = await f.request(
          uncomposed,
          new Browser(),
          "GetPublicGuestStudyPreparedContentV2",
          { path: source },
        );
        expect(refusedPrepared.status).toBe(404);
        expect(refusedPrepared.headers.get("cache-control")).toBe("private, no-store");
        expect(refusedPrepared.headers.getSetCookie()).toHaveLength(0);
        expect(publicPreparedCalls).toBe(0);
        expect(await f.snapshot()).toEqual(before);
        const worker = await f.makeWorker(),
          browser = new Browser();
        const preview = await f.request(worker, browser, "GetPublicGuestStudyPreparedContentV2", {
          path: source,
        });
        expect(preview.status).toBe(200);
        const practicePrepared = await body(preview, GuestStudyPreparedContentV2);
        expect(practicePrepared.disclosure.version).toBe(disclosure.version);
        expect(practicePrepared.reward_preview).toBeNull();
        expect(practicePrepared.reward_preview_terms_hash).toBeNull();
        expect(f.bindings.GUEST_STUDY_REWARDS_ENABLED).toBe("false");
        const proof = await bootstrap(
          browser,
          (name, input) => f.request(worker, browser, name, input),
          "default-native-authority",
        );
        const start = await f.request(worker, browser, "StartGuestStudySessionV1", {
          path: source,
          body: startBody(proof.owner_id, "default-native-start", false),
        });
        expect(start.status).toBe(201);
        expect(start.headers.getSetCookie()).toHaveLength(0);
        const session = await body(start, GuestStudySessionV1),
          locator = session.lesson.current;
        if (locator === null) throw new Error("Actual lesson current item required");
        const item = session.items.find((row) => row.session_item_id === locator.session_item_id);
        if (item === undefined || item.presentation.kind !== "say_it_back")
          throw new Error("Genuine read-aloud fixture item required");
        f.transcript(item.presentation.reference_text);
        const answerInput = {
          path: {
            communityId: source.communityId,
            sessionId: session.session_id,
            sessionItemId: item.session_item_id,
          },
          audio: new Uint8Array([7, 11, 19]),
          extraHeaders: {
            "content-type": "audio/webm",
            "idempotency-key": "default-native-answer",
            "x-study-attempt-number": "1",
            "x-audio-duration-ms": "1000",
          },
        };
        const answer = await f.request(worker, browser, "SubmitGuestStudyAnswerV1", answerInput);
        expect(answer.status).toBe(200);
        const accepted = await body(answer, GuestStudyAnswerResultV1);
        expect(accepted.participation.state).toBe("practice_only");
        expect(f.providerCalls()).toBe(1);
        expect(f.objects.size).toBe(1);
        const captured = await f.snapshot();
        expect(captured.checkpoints).toBe(1);
        const recovering = await f.makeWorker(null);
        const replay = await f.request(
          recovering,
          browser,
          "SubmitGuestStudyAnswerV1",
          answerInput,
        );
        expect(replay.status).toBe(200);
        expect(await body(replay, GuestStudyAnswerResultV1)).toEqual(accepted);
        expect(await f.snapshot()).toEqual(captured);
        expect(f.providerCalls()).toBe(1);
        expect(f.objects.size).toBe(1);
        const refused = await f.request(recovering, browser, "StartGuestStudySessionV1", {
          path: source,
          body: startBody(proof.owner_id, "new-without-config", false),
        });
        expect(refused.status).not.toBe(201);
        expect(refused.headers.getSetCookie()).toHaveLength(0);
        expect(await f.snapshot()).toEqual(captured);
        const retention = await f.request(recovering, browser, "SetGuestLearningRetentionV1", {
          body: { idempotency_key: "default-retention", mode: "ephemeral" },
        });
        expect(retention.status).toBe(200);
        expect((await body(retention, GuestLearningRetentionV1)).mode).toBe("ephemeral");
        const deletion = await f.request(recovering, browser, "DeleteGuestLearnerAudioV1", {
          extraHeaders: { "idempotency-key": "default-delete" },
        });
        expect(deletion.status).toBe(200);
        const deleted = await body(deletion, GuestLearnerAudioDeletionV1);
        expect(deleted.state).toBe("completed");
        expect(deleted.deleted_count).toBe(1);
        expect(deleted.remaining_count).toBe(0);
        expect(deleted.provider_disposition).toBe("unknown");
        expect(f.objects.size).toBe(0);
        const after = await f.snapshot();
        for (const field of ["accounts", "personas", "memberships"] as const)
          expect(after[field]).toBe(before[field]);
        expect(after.checkpoints).toBe(1);
        expect(f.providerCalls()).toBe(1);
      },
      await currentNativeSource(),
      false,
    );
  }, 120000);
  test("genuine Access RSA plus HMAC attach Guest proof to initiating app origin and refuse cross-origin proof/name-host forwarding", async () => {
    await defaultWorkerFixture(
      async (f) => {
        const worker = await f.makeWorker(),
          hns = await f.makeHns(),
          ordinary = new Browser();
        const ordinaryProof = await bootstrap(
          ordinary,
          (name, input) => f.request(worker, ordinary, name, input),
          "origin-ordinary",
        );
        const before = await f.snapshot();
        const cross = await f.forwarded(hns, ordinary, "RenewGuestAuthorityV1", {
          body: { expected_owner_id: ordinaryProof.owner_id },
        });
        expect(cross.status).toBe(401);
        expect(cross.headers.getSetCookie()).toHaveLength(0);
        expect(await f.snapshot()).toEqual(before);
        const app = new Browser(),
          appProof = await bootstrap(
            app,
            (name, input) => f.forwarded(hns, app, name, input),
            "origin-hns-app",
          );
        expect(appProof.owner_id).not.toBe(ordinaryProof.owner_id);
        const reverse = await f.request(worker, app, "RenewGuestAuthorityV1", {
          body: { expected_owner_id: appProof.owner_id },
        });
        expect(reverse.status).toBe(401);
        expect(reverse.headers.getSetCookie()).toHaveLength(0);
        const start = await f.forwarded(hns, app, "StartGuestStudySessionV1", {
          path: source,
          body: startBody(appProof.owner_id, "hns-start", false),
        });
        expect(start.status).toBe(201);
        expect((await body(start, GuestStudySessionV1)).owner_id).toBe(appProof.owner_id);
        const appHeaders = app.headers(false);
        const repeated = await hns.signed("/api/guest/authority", "GET", undefined, {
          headers: appHeaders,
        });
        const read1 = await f.taskFetch(
          hns.worker,
          new Request(repeated.url, { method: repeated.method, headers: repeated.headers }),
        );
        const read2 = await f.taskFetch(
          hns.worker,
          new Request(repeated.url, { method: repeated.method, headers: repeated.headers }),
        );
        expect(read1.status).toBe(200);
        expect(read2.status).toBe(200);
        expect((await body(read2, GuestAuthorityV1)).selected?.owner_id).toBe(appProof.owner_id);
        // This controlled gateway owns only its accepted app host. It cannot forward
        // any Guest cookie/proof to an unaccepted name host. Actual name-host runtime
        // admission remains a separate composed staging prerequisite.
        const beforeName = await f.snapshot();
        await expect(
          hns.signed("/api/guest/authority", "GET", undefined, {
            headers: app.headers(false),
            host: "xn--pokmon-dva",
          }),
        ).rejects.toThrow();
        expect(await f.snapshot()).toEqual(beforeName);
        expect(f.providerCalls()).toBe(0);
        expect(f.objects.size).toBe(0);
        expect(hns.keyReads()).toBe(1);
      },
      await currentNativeSource(),
      false,
    );
  }, 120000);
  test("real createProductionHttpWorker selects default binding graph without Guest runtime injection", async () => {
    await defaultWorkerFixture(
      async (f) => {
        const worker = await createProductionHttpWorker({
          ...f.ordinaryBindings,
          ...f.bindings,
          CORS_ORIGIN: ordinaryOrigin,
          API_NEXT_ENV: "development",
        });
        const browser = new Browser(),
          before = await f.snapshot();
        const call: Call = async (name, input = {}) => {
          const definition = (await import("@pirate/contracts")).guestParticipationRegistry[name];
          const headers = browser.headers(definition.method !== "GET");
          if (input.body !== undefined) headers.set("content-type", "application/json");
          return f.taskFetch(
            worker,
            new Request(`${ordinaryOrigin}${definition.path}`, {
              method: definition.method,
              headers,
              ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
            }),
          );
        };
        await bootstrap(browser, call, "production-hook-private");
        const after = await f.snapshot();
        expect(after.guests).toBe(before.guests + 1);
        for (const field of ["accounts", "personas", "memberships"] as const)
          expect(after[field]).toBe(before[field]);
        expect(f.providerCalls()).toBe(0);
        expect(f.objects.size).toBe(0);
      },
      await currentNativeSource(),
      false,
    );
  }, 120000);
});
