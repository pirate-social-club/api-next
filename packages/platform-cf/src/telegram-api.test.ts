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
  const api = makeTelegramApi((async (_url, init) => {
    requests.push(init ?? {});
    return response();
  }) as typeof fetch);
  return { api, requests };
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
