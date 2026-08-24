import {
  HNS_PLATFORM_APP_HOST,
  HNS_PLATFORM_CANONICAL_ORIGIN,
  HNS_PLATFORM_ROOT,
  HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE,
} from "@pirate/application/hns-static-platform-app-gateway";
import {
  admitHnsStaticPlatformGatewayRequest,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";
import {
  HnsStaticPlatformGatewayUpstreamError,
  sanitizeHnsStaticPlatformGatewayResponse,
} from "./response.ts";

export type HnsStaticPlatformGatewayFetch = (request: Request) => Promise<Response> | Response;

export type HnsStaticPlatformGatewayService = Readonly<{
  handle: (request: HnsStaticPlatformGatewayRequest) => Promise<Response>;
}>;

type GatewayTimer = ReturnType<typeof setTimeout>;
type GatewaySetTimeout = (callback: () => void, delay: number) => GatewayTimer;
type GatewayClearTimeout = (timer: GatewayTimer) => void;

export class HnsStaticPlatformGatewayCallerAbort extends Error {
  readonly name = "HnsStaticPlatformGatewayCallerAbort";
}

function redacted(status: number, allow?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(null, { status, headers });
}

export function makeHnsStaticPlatformGatewayService(input: {
  upstream_fetch: HnsStaticPlatformGatewayFetch;
  set_timeout?: GatewaySetTimeout;
  clear_timeout?: GatewayClearTimeout;
}): HnsStaticPlatformGatewayService {
  const setTimer = input.set_timeout ?? setTimeout;
  const clearTimer = input.clear_timeout ?? clearTimeout;

  return Object.freeze({
    handle: async (request) => {
      const admitted = admitHnsStaticPlatformGatewayRequest(request);
      if ("status" in admitted) {
        return redacted(admitted.status, admitted.status === 405 ? "GET, HEAD" : undefined);
      }
      if (admitted.host === HNS_PLATFORM_ROOT) {
        return new Response(null, {
          status: 301,
          headers: {
            "cache-control": "no-store",
            location: `https://${HNS_PLATFORM_APP_HOST}${admitted.target}`,
          },
        });
      }

      const controller = new AbortController();
      let terminal: "caller" | "deadline" | null = null;
      const abortFromCaller = () => {
        if (terminal !== null) return;
        terminal = "caller";
        controller.abort();
      };
      if (request.signal.aborted) throw new HnsStaticPlatformGatewayCallerAbort();
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimer(() => {
        if (terminal !== null) return;
        terminal = "deadline";
        controller.abort();
      }, HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[10]);

      try {
        let upstream: Response;
        try {
          const upstreamHeaders = new Headers(admitted.upstream_headers);
          upstreamHeaders.set("accept-encoding", "identity");
          upstream = await input.upstream_fetch(
            new Request(`${HNS_PLATFORM_CANONICAL_ORIGIN}${admitted.target}`, {
              method: admitted.method,
              headers: upstreamHeaders,
              redirect: "manual",
              signal: controller.signal,
            }),
          );
        } catch {
          if (terminal === "caller") throw new HnsStaticPlatformGatewayCallerAbort();
          return redacted(terminal === "deadline" ? 504 : 503);
        }
        if (terminal === "caller") throw new HnsStaticPlatformGatewayCallerAbort();
        if (terminal === "deadline") {
          await upstream.body?.cancel().catch(() => undefined);
          return redacted(504);
        }
        try {
          const sanitized = await sanitizeHnsStaticPlatformGatewayResponse(
            upstream,
            admitted.method,
          );
          if (terminal === "caller") throw new HnsStaticPlatformGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return sanitized;
        } catch (error) {
          if (terminal === "caller") throw new HnsStaticPlatformGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return redacted(error instanceof HnsStaticPlatformGatewayUpstreamError ? 502 : 503);
        }
      } finally {
        clearTimer(timer);
        request.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
