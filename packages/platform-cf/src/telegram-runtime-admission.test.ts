import { expect, spyOn, test } from "bun:test";
import { ControlPlaneDb, type ControlPlaneStatement } from "@pirate/application";
import type { TelegramServices } from "@pirate/application/telegram";
import { Effect, Layer } from "effect";
import {
  disabledTelegramConfiguration,
  telegramBindingsFixture,
  telegramConfigurationFixture,
} from "../../testing/src/telegram-configuration-fixture.ts";
import { makeTelegramLinkServices } from "./telegram-linking-runtime.ts";
import { makeTelegramServices, makeTelegramWake } from "./telegram-runtime.ts";
import { makeTelegramStudyServices } from "./telegram-study-runtime.ts";

function fixture() {
  const calls: ControlPlaneStatement[] = [];
  const execute = <R = unknown>(statement: ControlPlaneStatement) => {
    calls.push(statement);
    return Effect.succeed({ rows: [] as readonly R[], rowCount: 0 });
  };
  return {
    calls,
    runtime: Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
  };
}
const complete = {
  ...telegramBindingsFixture,
  TELEGRAM_CONFIG_JSON: JSON.stringify({ ...telegramConfigurationFixture, linking_enabled: false }),
};
test("disabled HTTP, jobs and linking setup never touch the database", async () => {
  const f = fixture();
  expect(
    await makeTelegramServices({ TELEGRAM_CONFIG_JSON: disabledTelegramConfiguration }, f.runtime),
  ).toBeNull();
  expect(
    await makeTelegramLinkServices(
      { TELEGRAM_CONFIG_JSON: disabledTelegramConfiguration },
      f.runtime,
      null,
    ),
  ).toBeNull();
  expect(f.calls).toEqual([]);
});
test("runtime setup refuses the actual executor before bot/provider construction", async () => {
  const f = fixture();
  expect(await makeTelegramServices(complete, f.runtime)).toBeNull();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.readonly).toBe(true);
  expect(f.calls[0]?.text).toContain("current_user");
  const inert = {} as TelegramServices;
  expect(await makeTelegramLinkServices(telegramBindingsFixture, f.runtime, inert)).toBeNull();
  expect(f.calls).toHaveLength(2);
});
test("practice defaults off and cannot be activated in production", () => {
  const f = fixture(),
    inert = {} as TelegramServices;
  expect(makeTelegramStudyServices({}, f.runtime, inert)).toBeUndefined();
  expect(() =>
    makeTelegramStudyServices(
      { TELEGRAM_STUDY_PRACTICE_ENABLED: "true", API_NEXT_ENV: "production" },
      f.runtime,
      inert,
    ),
  ).toThrow("requires staging");
  expect(f.calls).toEqual([]);
});

test("setup failures produce only fixed diagnostics and leave Telegram unavailable", async () => {
  const f = fixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await makeTelegramServices(complete, f.runtime)).toBeNull();
    expect(
      await makeTelegramServices(
        { ...complete, TELEGRAM_SECRETS_JSON: "secret malformed key" },
        f.runtime,
      ),
    ).toBeNull();
    expect(
      await makeTelegramLinkServices(
        { TELEGRAM_CONFIG_JSON: "invalid", TELEGRAM_SECRETS_JSON: "secret" },
        f.runtime,
        null,
      ),
    ).toBeNull();
    expect(log.mock.calls).toEqual([
      [
        "Telegram chat setup unavailable; chat operations disabled",
        { category: "permission_refused" },
      ],
      ["Telegram chat setup unavailable; chat operations disabled", { category: "configuration" }],
      [
        "Telegram linking setup unavailable; linking operations disabled",
        { category: "configuration" },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});

test("chat and linking query failures never log database errors or connection details", async () => {
  const execute = (_statement: ControlPlaneStatement) =>
    Effect.die("postgres://fixture-user:fixture-password@fixture-host; fixture-bot-secret");
  const runtime = Layer.succeed(ControlPlaneDb, {
    execute,
    withTransaction: (use) => use({ execute }),
  });
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await makeTelegramServices(complete, runtime)).toBeNull();
    expect(
      await makeTelegramLinkServices(telegramBindingsFixture, runtime, {} as TelegramServices),
    ).toBeNull();
    expect(log.mock.calls).toEqual([
      ["Telegram chat setup unavailable; chat operations disabled", { category: "query_failed" }],
      [
        "Telegram linking setup unavailable; linking operations disabled",
        { category: "query_failed" },
      ],
    ]);
  } finally {
    log.mockRestore();
  }
});

test("a Worker that can defer handles updates and their replies itself; the queue backs it up", async () => {
  const queued: string[] = [],
    handled: string[] = [];
  let wake: ReturnType<typeof makeTelegramWake> = async () => {};
  const base = {
    queue: {
      send: async (work: { kind: string; id: string }, options?: { delaySeconds?: number }) => {
        queued.push(`${work.kind}:${work.id}${options ? `@${options.delaySeconds}` : ""}`);
      },
    },
    inbox: async (id: string) => {
      handled.push(`inbox:${id}`);
      if (id === "fails") throw Error("processing failed");
      // An update's replies are woken from inside its own processing.
      await wake({ kind: "delivery", id: `${id}-reply` });
    },
    delivery: async (id: string) => {
      handled.push(`delivery:${id}`);
      if (id === "lost-reply") throw Error("send failed");
    },
  };
  // A queue consumer has nothing to defer with and keeps queueing.
  wake = makeTelegramWake({ ...base, defer: undefined });
  await wake({ kind: "inbox", id: "a" });
  await wake({ kind: "delivery", id: "b" });
  expect(queued).toEqual(["inbox:a", "delivery:b"]);
  expect(handled).toEqual([]);
  queued.length = 0;
  const background: Promise<unknown>[] = [];
  const timings: unknown[] = [];
  const info = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    timings.push(args);
  });
  wake = makeTelegramWake({
    ...base,
    defer: (work) => {
      background.push(work());
      return true;
    },
  });
  await wake({ kind: "inbox", id: "c" });
  await wake({ kind: "inbox", id: "fails" });
  await wake({ kind: "inbox", id: "lost" });
  // A message enqueued outside an update, such as a publication, is not sent inline.
  await wake({ kind: "delivery", id: "publication" });
  await Promise.all(background);
  info.mockRestore();
  expect(handled).toEqual([
    "inbox:c",
    "delivery:c-reply",
    "inbox:fails",
    "inbox:lost",
    "delivery:lost-reply",
  ]);
  expect(queued.sort()).toEqual(
    [
      // Every inline update leaves a delayed backstop for an interrupted run.
      "inbox:c@130",
      "inbox:fails@130",
      "inbox:lost@130",
      // A reply that could not be sent inline falls back to the queue.
      "delivery:lost-reply",
      "delivery:publication",
    ].sort(),
  );
  // Each background update reports its outcome and duration, and nothing that identifies it.
  expect(timings).toEqual([
    ["telegram.inline_update", { outcome: "handled", elapsed_ms: expect.any(Number) }],
    ["telegram.inline_update", { outcome: "failed", elapsed_ms: expect.any(Number) }],
    ["telegram.inline_update", { outcome: "handled", elapsed_ms: expect.any(Number) }],
  ]);
  queued.length = 0;
  handled.length = 0;
  // Outside a request nothing can be deferred, so the update is queued at once instead.
  wake = makeTelegramWake({ ...base, defer: () => false });
  await wake({ kind: "inbox", id: "e" });
  expect(queued).toEqual(["inbox:e"]);
  expect(handled).toEqual([]);
});
test("a reply's content hash survives stored key reordering, and its slot sets its id", async () => {
  const enqueued: { id: string; desiredHash: string | null; desired: unknown }[] = [];
  const woken: string[] = [];
  const telegram = {
    vault: { hash: async (value: string) => `hash(${value})` },
    store: {
      enqueueDelivery: async (record: (typeof enqueued)[number]) => {
        enqueued.push(record);
      },
    },
    wake: async (work: { id: string }) => {
      woken.push(work.id);
    },
  } as unknown as TelegramServices;
  const study = makeTelegramStudyServices(
    {
      TELEGRAM_STUDY_PRACTICE_ENABLED: "true",
      TELEGRAM_STUDY_PRACTICE_COMMUNITY_ID: "community",
      TELEGRAM_STUDY_PRACTICE_POST_IDS_JSON: '["post"]',
      API_NEXT_ENV: "staging",
      ELEVENLABS_API_KEY: "fixture",
      LEARNER_AUDIO: {} as never,
    },
    fixture().runtime,
    telegram,
  );
  if (!study) throw Error("practice services were not built");
  const sender = { communityId: "community", botId: "1", epoch: "e", telegramUserId: "2" };
  const prompt = {
    kind: "text" as const,
    text: "Say this back:\nHold on",
    media: null,
    buttons: [],
    keyboard: { force_reply: true, selective: true },
  };
  const feedbackId = await study.reply(
    sender,
    "inbox",
    "2",
    { kind: "text", text: "Correct.", media: null, buttons: [], replyTo: 9 },
    "feedback",
  );
  const promptId = await study.reply(sender, "inbox", "2", { ...prompt, after: feedbackId });
  expect([feedbackId, promptId]).toEqual(["hash(inbox:feedback)", "hash(inbox:reply)"]);
  expect(woken).toEqual([feedbackId, promptId]);
  expect(enqueued[0]?.desired).toMatchObject({ text: "Correct.", replyTo: 9 });
  expect(enqueued[1]?.desired).toMatchObject({ after: feedbackId });
  // Stored state returns the same message with its keys in another order.
  await study.reply(sender, "inbox", "2", {
    after: feedbackId,
    keyboard: { selective: true, force_reply: true },
    buttons: [],
    media: null,
    text: prompt.text,
    kind: "text",
  });
  expect(enqueued[2]?.desiredHash).toBe(enqueued[1]?.desiredHash);
  expect(enqueued[2]?.desiredHash).not.toBe(enqueued[0]?.desiredHash);
});
