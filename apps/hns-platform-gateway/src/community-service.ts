import { HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE } from "@pirate/application/hns-community-app-gateway";
import {
  HnsForwarderFailure,
  type HnsForwarderGatewayEnvelopeV1,
  type HnsForwarderGatewayInputV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import {
  admitHnsCommunityAppGatewayRequest,
  type HnsCommunityAppGatewayAdmission,
} from "./community-request.ts";
import {
  HnsCommunityAppGatewayUpstreamError,
  sanitizeHnsCommunityAppGatewayResponse,
} from "./community-response.ts";
import type { HnsStaticPlatformGatewayRequest } from "./request.ts";

export type HnsCommunityAppGatewayFetch = (request: Request) => Promise<Response> | Response;

export type HnsCommunityAppGatewaySigner = Readonly<{
  sign: (input: HnsForwarderGatewayInputV1) => Promise<HnsForwarderGatewayEnvelopeV1>;
}>;

export type HnsCommunityAppGatewayService = Readonly<{
  handle: (request: HnsStaticPlatformGatewayRequest) => Promise<Response>;
}>;

type GatewayTimer = ReturnType<typeof setTimeout>;
type GatewaySetTimeout = (callback: () => void, delay: number) => GatewayTimer;
type GatewayClearTimeout = (timer: GatewayTimer) => void;

export class HnsCommunityAppGatewayCallerAbort extends Error {
  readonly name = "HnsCommunityAppGatewayCallerAbort";
}

class HnsCommunityAppGatewayTerminal extends Error {
  readonly name = "HnsCommunityAppGatewayTerminal";
}

function redacted(status: number, allow?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(null, { status, headers });
}

function authorityMatches(
  envelope: HnsForwarderGatewayEnvelopeV1,
  admitted: HnsCommunityAppGatewayAdmission,
  deploymentReference: string,
): boolean {
  const state = envelope.authority.state;
  return (
    envelope.authority.normalized_host === admitted.normalized_host &&
    envelope.authority.canonical_root === admitted.canonical_root &&
    envelope.authority.host_authority[0] === "community_app_v1" &&
    state.variant === "community_app_v1" &&
    state.normalized_host === admitted.normalized_host &&
    state.canonical_root === admitted.canonical_root &&
    state.activation_gateway_deployment_reference === deploymentReference &&
    state.dns_zone.gateway_deployment_reference === deploymentReference
  );
}

function signerFailureResponse(error: unknown): Response {
  if (!(error instanceof HnsForwarderFailure)) return redacted(503);
  if (error.reason === "body_too_large") return redacted(413);
  if (error.reason === "invalid_request") return redacted(400);
  if (error.reason === "authority_unavailable") return redacted(421);
  return redacted(503);
}

export function makeHnsCommunityAppGatewayService(input: {
  signer: HnsCommunityAppGatewaySigner;
  gateway_deployment_reference: string;
  solid_origin: string;
  upstream_fetch: HnsCommunityAppGatewayFetch;
  set_timeout?: GatewaySetTimeout;
  clear_timeout?: GatewayClearTimeout;
}): HnsCommunityAppGatewayService {
  const setTimer = input.set_timeout ?? setTimeout;
  const clearTimer = input.clear_timeout ?? clearTimeout;

  return Object.freeze({
    handle: async (request) => {
      const admitted = admitHnsCommunityAppGatewayRequest(request);
      if ("status" in admitted) return redacted(admitted.status, admitted.allow);

      const controller = new AbortController();
      let terminal: "caller" | "deadline" | null = null;
      let rejectTerminal: ((error: HnsCommunityAppGatewayTerminal) => void) | null = null;
      const terminalPromise = new Promise<never>((_resolve, reject) => {
        rejectTerminal = reject;
      });
      const selectTerminal = (next: "caller" | "deadline") => {
        if (terminal !== null) return;
        terminal = next;
        controller.abort();
        rejectTerminal?.(new HnsCommunityAppGatewayTerminal());
      };
      const abortFromCaller = () => selectTerminal("caller");
      if (request.signal.aborted) throw new HnsCommunityAppGatewayCallerAbort();
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimer(
        () => selectTerminal("deadline"),
        HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[14],
      );

      try {
        let envelope: HnsForwarderGatewayEnvelopeV1;
        try {
          envelope = await Promise.race([
            input.signer.sign({
              method: admitted.method,
              normalized_host: admitted.normalized_host,
              path_and_query: admitted.mapped_target,
              headers: admitted.upstream_headers,
              body_bytes: admitted.body_bytes,
            }),
            terminalPromise,
          ]);
        } catch (error) {
          if (terminal === "caller") throw new HnsCommunityAppGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return signerFailureResponse(error);
        }
        if (!authorityMatches(envelope, admitted, input.gateway_deployment_reference)) {
          return redacted(421);
        }

        let upstream: Response;
        try {
          const upstreamHeaders = new Headers(envelope.headers);
          upstreamHeaders.set("accept-encoding", "identity");
          const upstreamBody = admitted.body_bytes.slice().buffer as ArrayBuffer;
          upstream = await Promise.race([
            Promise.resolve(
              input.upstream_fetch(
                new Request(`${input.solid_origin}${admitted.mapped_target}`, {
                  method: admitted.method,
                  headers: upstreamHeaders,
                  ...(admitted.method === "POST" || admitted.method === "PATCH"
                    ? { body: upstreamBody }
                    : {}),
                  redirect: "manual",
                  signal: controller.signal,
                }),
              ),
            ),
            terminalPromise,
          ]);
        } catch {
          if (terminal === "caller") throw new HnsCommunityAppGatewayCallerAbort();
          return redacted(terminal === "deadline" ? 504 : 503);
        }
        if (terminal === "caller") throw new HnsCommunityAppGatewayCallerAbort();
        if (terminal === "deadline") {
          await upstream.body?.cancel().catch(() => undefined);
          return redacted(504);
        }
        try {
          const sanitized = await Promise.race([
            sanitizeHnsCommunityAppGatewayResponse(
              upstream,
              admitted.method,
              admitted.normalized_host,
            ),
            terminalPromise,
          ]);
          if (terminal === "caller") throw new HnsCommunityAppGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return sanitized;
        } catch (error) {
          if (terminal === "caller") throw new HnsCommunityAppGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return redacted(error instanceof HnsCommunityAppGatewayUpstreamError ? 502 : 503);
        }
      } finally {
        clearTimer(timer);
        request.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
