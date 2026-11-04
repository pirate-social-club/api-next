import { describe, expect, test } from "bun:test";
import { acceptTelegramUpdate, type TelegramServices } from "@pirate/application/telegram";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import {
  insertStudySongFixture,
  insertTelegramPracticeReadinessFixture,
} from "./study-v2-ready-song.pg-fixture.ts";
import { makeTelegramCredentialVault } from "./telegram-credential-vault.ts";
import { composeTelegramServices, consumeTelegramWork } from "./telegram-runtime.ts";
import { emptyTelegramIntegration } from "./telegram-settings-store.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !connectionString)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

type Body = {
  readonly text?: string;
  readonly reply_markup?: {
    readonly inline_keyboard?: readonly (readonly {
      readonly text: string;
      readonly callback_data?: string;
      readonly url?: string;
    }[])[];
    readonly force_reply?: boolean;
    readonly selective?: boolean;
  };
};
type Sent = { method: string; body: Body };
type Work = { kind: "inbox" | "delivery"; id: string };

/**
 * The path a learner's phone takes: the webhook accepts an update and the same Worker
 * handles it in the request's background. A services object that lost the practice service
 * on this path once served the discovery bot to a practice community.
 */
suite("Telegram practice through the webhook's inline path", () => {
  test("an accepted update is handled as practice, inline and through the queue alike", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = `api_next_telegram_http_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const scoped = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
    try {
      await applyPostgresTestBaselineConnection({ connectionString: scoped });
      const { lines } = await insertStudySongFixture(admin);
      await insertTelegramPracticeReadinessFixture(admin);
      // This historical HTTP fixture serves through its original owned schema
      // connection, not a newly invented production role. Existing account-birth
      // EXECUTE is already available; no new role or blanket grant is needed.
      expect(
        (
          await admin.query(
            "SELECT has_function_privilege(current_user,'provision_account_participation_owner_v1(text)','EXECUTE') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: true }]);
      const readLearnerSource = async (telegramUserId: string) =>
        (
          await admin.query(
            `SELECT o.owner_id,o.kind,o.account_id,s.session_id,
          s.participation_owner_id,s.participation_owner_kind,s.telegram_practice_only
          FROM telegram_restricted_learners l JOIN participation_owners o
            ON o.account_id=l.account_id AND o.kind='account'
          JOIN study_sessions_v2 s ON s.account_id=l.account_id
          WHERE l.telegram_user_id=$1 AND s.community_id='study-community'`,
            [telegramUserId],
          )
        ).rows;
      const keys = { v1: "a".repeat(43) };
      const vault = await makeTelegramCredentialVault({ activeVersion: "v1", keys });
      await admin.query(
        `INSERT INTO community_telegram_integrations(community_id,record,revision,bot_epoch,webhook_id,bot_id)
         VALUES('study-community',$1::jsonb,1,'epoch','hook','123')`,
        [
          JSON.stringify({
            ...emptyTelegramIntegration("study-community"),
            revision: 1,
            botEpoch: "epoch",
            botId: "123",
            botUsername: "fixture_bot",
            botToken: await vault.seal(
              JSON.stringify({ token: "123:fixture-token", secret: "hook-secret" }),
              "study-community:telegram:epoch",
            ),
            webhookId: "hook",
            webhookSecret: await vault.hash("hook-secret"),
            status: "ready",
          }),
        ],
      );
      const sent: Sent[] = [];
      let messageId = 100;
      const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1) ?? "";
        sent.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(
          JSON.stringify({
            ok: true,
            result: method === "sendMessage" ? { message_id: ++messageId } : true,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
      const compose = (queue: Work[], defer?: (work: () => Promise<unknown>) => boolean) =>
        composeTelegramServices({
          bindings: {
            TELEGRAM_CONFIG_JSON: JSON.stringify({
              version: 1,
              enabled: true,
              linking_enabled: false,
              practice_enabled: true,
              public_origin: "https://pirate.example.invalid",
              webhook_origin: "https://api.example.invalid",
              credential_active_version: "v1",
              practice_community_id: "study-community",
              practice_post_ids: ["study-post"],
            }),
            TELEGRAM_SECRETS_JSON: JSON.stringify({ version: 1, credential_keys: keys }),
            API_NEXT_ENV: "staging",
            ELEVENLABS_API_KEY: "fixture",
            LEARNER_AUDIO: {} as never,
          },
          runtime: makeDirectPostgresControlPlaneLayer(scoped),
          options: defer === undefined ? {} : { defer },
          queue: {
            send: async (work, options) => {
              queue.push({
                ...work,
                ...(options ? { id: `${work.id}@${options.delaySeconds}` } : {}),
              });
            },
          },
          publicOrigin: "https://pirate.example.invalid",
          webhookOrigin: "https://api.example.invalid",
          credentialActiveVersion: "v1",
          fetcher,
        });
      let updateId = 0;
      const message = (sender: number, text: string) => ({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          chat: { id: sender, type: "private" },
          from: { id: sender, is_bot: false, language_code: "en" },
          text,
        },
      });
      const callback = (sender: number, data: string) => ({
        update_id: ++updateId,
        callback_query: {
          id: `callback-${updateId}`,
          from: { id: sender, is_bot: false, language_code: "en" },
          message: { message_id: updateId, chat: { id: sender, type: "private" } },
          data,
        },
      });
      const lastMessage = () => sent.filter((call) => call.method === "sendMessage").at(-1)?.body;
      const songButton = (body: Body | undefined): string =>
        body?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "";
      const expectPracticePicker = (body: Body | undefined, heading: string) => {
        expect(body?.text).toBe(heading);
        // One callback button per practice song: no website link and no title list in the text.
        expect(body?.reply_markup?.inline_keyboard).toEqual([
          [{ text: "Study song", callback_data: expect.stringMatching(/^study:[^:]+:0$/u) }],
        ]);
        expect(JSON.stringify(body)).not.toContain("https://");
      };

      // The HTTP Worker: updates are handled in the background of the request that stored them.
      const queued: Work[] = [];
      const background: Promise<unknown>[] = [];
      const inline: TelegramServices = await compose(queued, (work) => {
        background.push(work());
        return true;
      });
      const receive = async (services: TelegramServices, update: Record<string, unknown>) => {
        expect(
          await acceptTelegramUpdate(services, "hook", "hook-secret", update as never),
        ).toEqual({ ok: true });
        await Promise.all(background.splice(0));
      };
      await receive(inline, message(555, "/start"));
      expectPracticePicker(lastMessage(), "Choose a song to study:");
      await receive(inline, callback(555, "tg-menu:songs"));
      expectPracticePicker(lastMessage(), "Choose a song to study:");
      await receive(inline, message(555, "/help"));
      expect(lastMessage()?.text).toContain("/study shows the songs");
      expect(lastMessage()?.text).not.toContain("not available in this bot");
      await receive(inline, message(555, "/study"));
      expectPracticePicker(lastMessage(), "Choose a song to study:");
      await receive(inline, callback(555, songButton(lastMessage())));
      const prompt = lastMessage();
      // The first prompt is the instruction and the line, with nothing after it.
      expect(prompt?.text).toBe(`Say this back:\n${lines[0]}`);
      expect(prompt?.reply_markup).toEqual({ force_reply: true, selective: true });
      const originalInlineSource = await readLearnerSource("555");
      expect(originalInlineSource).toHaveLength(1);
      expect(originalInlineSource[0]).toMatchObject({
        kind: "account",
        participation_owner_kind: "account",
        telegram_practice_only: true,
      });
      expect(originalInlineSource[0]?.owner_id).toMatch(/^owner_[0-9a-f-]{36}$/u);
      expect(originalInlineSource[0]?.participation_owner_id).toBe(
        originalInlineSource[0]?.owner_id,
      );
      await receive(inline, message(555, "/resume"));
      expect(lastMessage()?.text).toBe(`Say this back:\n${lines[0]}`);
      expect(await readLearnerSource("555")).toEqual(originalInlineSource);
      // Nothing asked about age, and nothing pointed at the website. Only what the learner
      // reads is searched: a button's random token may contain any digits.
      const shown = sent.flatMap((call) => [
        call.body.text ?? "",
        ...(call.body.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.text),
      ]);
      expect(shown.join("\n")).not.toContain("16");
      expect(JSON.stringify(sent)).not.toContain("https://");
      // Replies were sent inline; the queue holds only the delayed backstop for each update.
      expect(queued).toHaveLength(6);
      expect(queued.every((work) => work.kind === "inbox" && work.id.endsWith("@130"))).toBe(true);
      expect(
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM telegram_restricted_learners) AS learners,
               (SELECT count(*)::int FROM study_sessions_v2 WHERE telegram_practice_only) AS sessions,
               (SELECT count(*)::int FROM account_minimum_age_attestations) AS attestations,
               (SELECT count(*)::int FROM community_telegram_inbox WHERE state<>'completed') AS unfinished`,
          )
        ).rows,
      ).toEqual([{ learners: 1, sessions: 1, attestations: 0, unfinished: 0 }]);

      // The jobs Worker: the same update handled from the queue behaves identically.
      const consumerQueue: Work[] = [];
      const consumer = await compose(consumerQueue);
      const drain = async () => {
        for (let work = consumerQueue.shift(); work; work = consumerQueue.shift())
          await consumeTelegramWork(consumer, work);
      };
      await receive(consumer, message(777, "/start"));
      expect(consumerQueue).toHaveLength(1);
      await drain();
      expectPracticePicker(lastMessage(), "Choose a song to study:");
      await receive(consumer, callback(777, songButton(lastMessage())));
      await drain();
      expect(lastMessage()?.text).toBe(`Say this back:\n${lines[0]}`);
      const originalQueuedSource = await readLearnerSource("777");
      expect(originalQueuedSource).toHaveLength(1);
      expect(originalQueuedSource[0]).toMatchObject({
        kind: "account",
        participation_owner_kind: "account",
        telegram_practice_only: true,
      });
      expect(originalQueuedSource[0]?.participation_owner_id).toBe(
        originalQueuedSource[0]?.owner_id,
      );
      expect(originalQueuedSource[0]?.owner_id).not.toBe(originalInlineSource[0]?.owner_id);
      expect(await readLearnerSource("555")).toEqual(originalInlineSource);
      // Both actual source histories remain practice-only and cannot qualify or
      // earn a chance merely from anonymous/restricted Telegram activity.
      expect(
        (
          await admin.query(`SELECT
        (SELECT count(*)::int FROM activity_qualifications) AS qualifications,
        (SELECT count(*)::int FROM participation_owners WHERE kind='guest') AS guest_owners`)
        ).rows,
      ).toEqual([{ qualifications: 0, guest_owners: 0 }]);
    } finally {
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
  }, 120_000);
});
