/**
 * Local Study/Karaoke browser-harness Worker entry.
 *
 * This entry is local-only and must never be deployed: it composes the real
 * production HTTP worker (routes, authorization, grading, persistence,
 * Durable Object protocol and finalization) with exactly two replaced
 * dependencies:
 *
 * 1. the Study batch transcriber, injected through the existing
 *    `study_batch_transcriber` composition seam, and
 * 2. the Karaoke streaming STT adapter, constructed by a scripted override of
 *    the reviewed protected `makeSttAdapter` factory.
 *
 * It also installs a loopback-only fetch guard so an unexpected provider call
 * fails closed in the Worker, not only in the browser.
 */

import {
  createProductionHttpWorker,
  type HttpWorkerBindings,
} from "../../apps/http-worker/src/composition.ts";
import { makeRetryingPromiseCache } from "../../apps/http-worker/src/production-app-cache.ts";
import type { KaraokeAttemptDoStub } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import { KaraokeAttemptDO as ProductionKaraokeAttemptDO } from "../../packages/platform-cf/src/karaoke-attempt-do.ts";
import posterJpeg from "./assets/poster.jpg";
import {
  type KaraokeSttScriptMode,
  type KaraokeSttScriptState,
  ScriptedKaraokeSttAdapter,
} from "./karaoke-stt-double.ts";
import {
  ScriptedStudyTranscriber,
  type StudyTranscriptScript,
} from "./study-transcriber-double.ts";

export { HnsForwarderReplayStoreDO } from "../../packages/platform-cf/src/hns-forwarder-replay-store-do.ts";
export { KaraokeResetOperatorEntrypoint } from "../../packages/platform-cf/src/karaoke-reset-operator-entrypoint.ts";
export {
  RegistrationApplicationRateLimiterDO,
  RegistrationIpRateLimiterDO,
} from "../../packages/platform-cf/src/registration-rate-limiter-do.ts";
export { VideoPlaybackRateLimiterDO } from "../../packages/platform-cf/src/video-playback-rate-limiter-do.ts";

export const harnessStudyTranscriber = new ScriptedStudyTranscriber();

export interface HarnessKaraokeAttemptStub extends KaraokeAttemptDoStub {
  readonly harnessSetSttMode: (mode: KaraokeSttScriptMode) => Promise<void>;
  readonly harnessSttState: () => Promise<KaraokeSttScriptState>;
}

export type HarnessBindings = Omit<HttpWorkerBindings, "KARAOKE_ATTEMPT"> & {
  readonly KARAOKE_ATTEMPT?: {
    readonly getByName: (name: string) => HarnessKaraokeAttemptStub;
  };
};

export class ScriptedKaraokeAttemptDO extends ProductionKaraokeAttemptDO {
  private readonly sttScript: KaraokeSttScriptState = { mode: "correct", emissions: [] };

  harnessSetSttMode(mode: KaraokeSttScriptMode): void {
    // Mutate in place: the constructed adapter holds this same state object.
    this.sttScript.mode = mode;
    this.sttScript.emissions = [];
  }

  harnessSttState(): KaraokeSttScriptState {
    return this.sttScript;
  }

  protected override makeSttAdapter(_apiKey: string) {
    const authority = this.authority();
    return new ScriptedKaraokeSttAdapter({
      lines: authority.lines,
      state: this.sttScript,
      sessionId: authority.sessionId,
      attemptId: authority.attemptId,
    });
  }
}

const outboundAttempts: { url: string; method: string; at: string }[] = [];
let outboundGuardInstalled = false;

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function installLoopbackFetchGuard(): void {
  if (outboundGuardInstalled) return;
  outboundGuardInstalled = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!loopbackUrl(url)) {
        outboundAttempts.push({
          url,
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          at: new Date().toISOString(),
        });
        return Promise.reject(new Error(`harness_outbound_blocked:${url}`));
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  } catch {
    // The runtime refused the wrap; the doubles plus the loopback-only wrangler
    // configuration remain the containment. Record that the guard is absent.
    outboundAttempts.push({
      url: "harness:fetch-guard-not-installed",
      method: "NONE",
      at: new Date().toISOString(),
    });
  }
}

installLoopbackFetchGuard();

const json = (value: unknown, status = 200): Response =>
  Response.json(value as Record<string, unknown>, { status });

async function handleHarnessRoute(
  request: Request,
  bindings: HarnessBindings,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__harness__/")) return null;
  if (request.method === "GET" && url.pathname === "/__harness__/outbound") {
    return json({ attempts: outboundAttempts });
  }
  if (request.method === "POST" && url.pathname === "/__harness__/study/arm") {
    const body = (await request.json()) as Readonly<{
      script?: StudyTranscriptScript;
      scripts?: readonly StudyTranscriptScript[];
      fallback?: StudyTranscriptScript;
      reset?: boolean;
    }>;
    if (body.reset === true) harnessStudyTranscriber.reset();
    if (body.script !== undefined) harnessStudyTranscriber.arm(body.script);
    if (body.scripts !== undefined) harnessStudyTranscriber.armSequence(body.scripts);
    if (body.fallback !== undefined) harnessStudyTranscriber.setFallback(body.fallback);
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/__harness__/study/calls") {
    return json({ calls: harnessStudyTranscriber.calls });
  }
  if (request.method === "POST" && url.pathname === "/__harness__/karaoke/arm") {
    const body = (await request.json()) as Readonly<{
      sessionId: string;
      mode: KaraokeSttScriptMode;
    }>;
    const namespace = bindings.KARAOKE_ATTEMPT;
    if (namespace === undefined) return json({ ok: false, reason: "karaoke_binding_missing" }, 500);
    await namespace.getByName(body.sessionId).harnessSetSttMode(body.mode);
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/__harness__/karaoke/state") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const namespace = bindings.KARAOKE_ATTEMPT;
    if (namespace === undefined || sessionId === "") {
      return json({ ok: false, reason: "karaoke_binding_missing" }, 500);
    }
    return json({ ok: true, state: await namespace.getByName(sessionId).harnessSttState() });
  }
  return json({ ok: false, reason: "unknown_harness_route", path: url.pathname }, 404);
}

const productionApp = makeRetryingPromiseCache(async (bindings: HarnessBindings) =>
  createProductionHttpWorker(bindings, {
    study_batch_transcriber: harnessStudyTranscriber,
  }),
);

/** The seeded video fixtures the review feed plays. */
const seededVideoPostIds = new Set([
  "post_harness_video_linked",
  "post_harness_video_unlinked",
  "post_harness_video_unavailable",
]);

/**
 * Local playback double for the review feed. The real client still mints
 * playback access through the real endpoint and validates the grant shape;
 * this answers with a grant pointing at the loopback TLS media server that
 * Chromium maps the customer host onto (see media.ts), and serves the
 * committed harness thumbnail for the poster route. Local-only; never
 * deployable, and it answers for the seeded posts only.
 */
async function handleVideoAccessDouble(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/posts\/([^/]+)\/video\/(playback-access|poster)$/u);
  if (match === null) return null;
  const postId = decodeURIComponent(match[1] ?? "");
  if (!seededVideoPostIds.has(postId)) return json({ ok: false, reason: "video_not_seeded" }, 404);
  if (match[2] === "poster") {
    return new Response(posterJpeg, {
      headers: {
        "cache-control": "private, no-cache",
        "content-type": "image/jpeg",
        etag: `"harness-${postId}"`,
      },
    });
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const now = Math.floor(Date.now() / 1000);
  return json({
    playback_url:
      "https://customer-harness.cloudflarestream.com/harness.harness.harness/manifest/video.m3u8",
    expires_at: now + 240,
    renew_after: now + 120,
  });
}

export default {
  async fetch(request: Request, bindings: HarnessBindings, ctx: ExecutionContext) {
    const harnessResponse = await handleHarnessRoute(request, bindings);
    if (harnessResponse !== null) return harnessResponse;
    const videoAccessResponse = await handleVideoAccessDouble(request);
    if (videoAccessResponse !== null) return videoAccessResponse;
    const realtimeMatch = new URL(request.url).pathname.match(/^\/karaoke\/realtime\/([^/]+)$/u);
    if (realtimeMatch !== null) {
      const encodedSessionId = realtimeMatch[1];
      if (encodedSessionId === undefined || bindings.KARAOKE_ATTEMPT === undefined) {
        return new Response("Not found", { status: 404 });
      }
      const sessionId = decodeURIComponent(encodedSessionId);
      return bindings.KARAOKE_ATTEMPT.getByName(sessionId).fetch(request);
    }
    const worker = await productionApp(bindings);
    return worker.fetch(request, bindings as HttpWorkerBindings, ctx);
  },
};
