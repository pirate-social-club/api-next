import { expect, test } from "bun:test";
import type { DeliveryRecord } from "@pirate/application/telegram";
import { makeTelegramApi } from "./telegram-api.ts";

const delivery: DeliveryRecord = {
  id: "delivery",
  communityId: "community",
  botEpoch: "epoch",
  chatId: "-10001",
  kind: "publication",
  postId: "post",
  state: "pending",
  desired: { kind: "text", text: "Public post", media: null, buttons: [] },
  desiredHash: "new",
  confirmed: null,
  confirmedHash: null,
  messageId: null,
  attempt: "attempt",
  attemptCount: 1,
  lastError: null,
  createdAt: "2026-09-08T00:00:00.000Z",
};
const token = "123:fixture_token";
function fixture(response: () => Response | Promise<Response>) {
  const requests: RequestInit[] = [];
  const urls: string[] = [];
  const api = makeTelegramApi((async (url, init) => {
    requests.push(init ?? {});
    urls.push(String(url));
    return response();
  }) as typeof fetch);
  return { api, requests, urls };
}

test("missing and malformed acknowledgements remain uncertain without a transport retry", async () => {
  for (const response of [
    () => Response.json({ ok: true }),
    () => new Response("not-json"),
    () => Promise.reject(new Error("fixture network failure")),
  ]) {
    const f = fixture(response);
    expect(await f.api.dispatch(token, delivery, "send")).toEqual({
      kind: "uncertain",
      code: "acknowledgement_unavailable",
    });
    expect(f.requests).toHaveLength(1);
  }
});

test("Telegram retry_after is retained without leaking provider description", async () => {
  const f = fixture(() =>
    Response.json(
      {
        ok: false,
        error_code: 429,
        description: "sensitive fixture",
        parameters: { retry_after: 75 },
      },
      { status: 429 },
    ),
  );
  expect(await f.api.dispatch(token, delivery, "send")).toEqual({
    kind: "rejected",
    code: "telegram_429",
    retryAfter: 75,
  });
});

test("media edits replace the media and caption together", async () => {
  const f = fixture(() => Response.json({ ok: true, result: { message_id: 11 } }));
  expect(
    await f.api.dispatch(
      token,
      {
        ...delivery,
        messageId: 11,
        desired: {
          kind: "photo",
          media: "https://media.example.invalid/new.jpg",
          text: "Updated",
          buttons: [],
        },
      },
      "edit",
    ),
  ).toEqual({ kind: "confirmed", messageId: 11 });
  expect(JSON.parse(String(f.requests[0]?.body))).toMatchObject({
    message_id: 11,
    media: { type: "photo", media: "https://media.example.invalid/new.jpg", caption: "Updated" },
  });
  expect(f.requests[0]?.redirect).toBe("manual");
});

test("a voice reply sends audio without repeating the written answer as a caption", async () => {
  const f = fixture(() => Response.json({ ok: true, result: { message_id: 12 } }));
  expect(
    await f.api.dispatch(
      token,
      { ...delivery, desired: { kind: "voice", text: "", media: null, buttons: [] } },
      "send",
    ),
  ).toEqual({ kind: "confirmed", messageId: 12 });
  const body = JSON.parse(String(f.requests[0]?.body));
  expect(body).not.toHaveProperty("caption");
  expect(body.voice).toBeNull();
});

test("voice edits use the caption method rather than editMessageMedia", async () => {
  const f = fixture(() => Response.json({ ok: true, result: { message_id: 11 } }));
  expect(
    await f.api.dispatch(
      token,
      {
        ...delivery,
        messageId: 11,
        desired: { kind: "voice", text: "Caption", media: null, buttons: [] },
      },
      "edit",
    ),
  ).toEqual({ kind: "confirmed", messageId: 11 });
  expect(String(f.urls[0])).toContain("/editMessageCaption");
  const body = JSON.parse(String(f.requests[0]?.body));
  expect(body.caption).toBe("Caption");
  expect(body).not.toHaveProperty("media");
});

test("redirects never forward a bot token and remain uncertain", async () => {
  const f = fixture(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example.invalid" },
      }),
  );
  expect((await f.api.dispatch(token, delivery, "send")).kind).toBe("uncertain");
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.redirect).toBe("manual");
});

test("an unavailable deletion target requires review instead of claiming withdrawal", async () => {
  const f = fixture(() =>
    Response.json(
      { ok: false, error_code: 400, description: "Bad Request: message to delete not found" },
      { status: 400 },
    ),
  );
  expect(
    await f.api.dispatch(
      token,
      { ...delivery, messageId: 42, desired: null, desiredHash: null },
      "delete",
    ),
  ).toEqual({ kind: "uncertain", code: "deletion_target_unavailable" });
  expect(f.requests).toHaveLength(1);
  expect(JSON.parse(String(f.requests[0]?.body))).toEqual({
    chat_id: delivery.chatId,
    message_id: 42,
  });
});

test("delete permission rejection and transport uncertainty never confirm absence", async () => {
  for (const [code, description] of [
    [400, "Bad Request: message can't be deleted"],
    [403, "Forbidden: bot was kicked"],
  ] as const) {
    const f = fixture(() =>
      Response.json({ ok: false, error_code: code, description }, { status: code }),
    );
    expect(
      await f.api.dispatch(
        token,
        { ...delivery, messageId: 42, desired: null, desiredHash: null },
        "delete",
      ),
    ).toEqual({ kind: "rejected", code: `telegram_${code}`, retryAfter: null });
  }
  const lost = fixture(() => Promise.reject(new Error("lost acknowledgement")));
  expect(
    await lost.api.dispatch(
      token,
      { ...delivery, messageId: 42, desired: null, desiredHash: null },
      "delete",
    ),
  ).toEqual({ kind: "uncertain", code: "acknowledgement_unavailable" });
});
