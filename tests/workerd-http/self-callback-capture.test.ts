/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as testEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeSelfCallbackCaptureService } from "../../apps/http-worker/src/self-callback-capture.ts";
import type { SelfCallbackCaptureDO } from "../../apps/http-worker/src/self-callback-capture-do.ts";

const env = testEnv as unknown as {
  readonly SELF_CALLBACK_CAPTURE: DurableObjectNamespace<SelfCallbackCaptureDO>;
};

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe("Self callback capture Durable Object", () => {
  it("captures one bounded raw callback, replays it once, and clears it", async () => {
    const stub = env.SELF_CALLBACK_CAPTURE.getByName(`test-${crypto.randomUUID()}`);
    const empty = await stub.fetch("https://capture.test/status");
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({
      state: "empty",
      provider_id: null,
      digest: null,
      length: null,
      captured_at: null,
      replayed: false,
    });

    const rawBody = '{"signed":"héllo"}';
    const captured = await stub.fetch("https://capture.test/capture", {
      method: "POST",
      headers: {
        "x-callback-provider": "self.pass",
        "x-callback-headers": JSON.stringify({ "content-type": "application/json" }),
      },
      body: new TextEncoder().encode(rawBody),
    });
    expect(captured.status).toBe(201);
    const capturedStatus = await json(captured);
    expect(capturedStatus).toMatchObject({
      state: "captured",
      provider_id: "self.pass",
      length: new TextEncoder().encode(rawBody).byteLength,
      replayed: false,
    });

    const duplicate = await stub.fetch("https://capture.test/capture", {
      method: "POST",
      headers: {
        "x-callback-provider": "self.pass",
        "x-callback-headers": JSON.stringify({ "content-type": "text/plain" }),
      },
      body: "different",
    });
    expect(duplicate.status).toBe(200);
    expect(await json(duplicate)).toEqual(capturedStatus);

    const status = await stub.fetch("https://capture.test/status");
    expect((await json(status)).replayed).toBe(false);

    const replay = await stub.fetch("https://capture.test/replay", { method: "POST" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-callback-provider")).toBe("self.pass");
    expect(replay.headers.get("x-callback-length")).toBe(
      String(new TextEncoder().encode(rawBody).byteLength),
    );
    expect(replay.headers.get("x-callback-digest")).toMatch(/^[0-9a-f]{64}$/u);
    expect(replay.headers.get("x-callback-headers")).toBe(
      JSON.stringify({ "content-type": "application/json" }),
    );
    expect(new TextDecoder().decode(await replay.arrayBuffer())).toBe(rawBody);

    const secondReplay = await stub.fetch("https://capture.test/replay", { method: "POST" });
    expect(secondReplay.status).toBe(409);
    const replayedStatus = await stub.fetch("https://capture.test/status");
    expect((await json(replayedStatus)).replayed).toBe(true);

    const cleared = await stub.fetch("https://capture.test/capture", { method: "DELETE" });
    expect(await json(cleared)).toEqual({ cleared: true });
    const afterClear = await stub.fetch("https://capture.test/status");
    expect((await json(afterClear)).state).toBe("empty");
  });

  it("rejects malformed capture metadata without storing a record", async () => {
    const stub = env.SELF_CALLBACK_CAPTURE.getByName(`invalid-${crypto.randomUUID()}`);
    const response = await stub.fetch("https://capture.test/capture", {
      method: "POST",
      headers: {
        "x-callback-provider": "self.pass\n",
        "x-callback-headers": "not-json",
      },
      body: "sensitive-but-invalid",
    });
    expect(response.status).toBe(400);
    const status = await stub.fetch("https://capture.test/status");
    expect((await json(status)).state).toBe("empty");
  });

  it("uses the application service seam without exposing replay bytes", async () => {
    const service = makeSelfCallbackCaptureService(env.SELF_CALLBACK_CAPTURE);
    const status = await service.status();
    expect(status.state).toBe("empty");
    const captured = await service.capture("self.pass", '{"ok":true}', {
      "content-type": "application/json",
    });
    expect(captured.length).toBe(11);
    const replay = await service.replay();
    expect(replay.raw_body).toBe('{"ok":true}');
    expect(replay.headers).toEqual({ "content-type": "application/json" });
    expect(replay.digest).toMatch(/^[0-9a-f]{64}$/u);
    await service.clear();
  });
});
