import { HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE } from "@pirate/application/hns-community-handle-gateway";
import {
  HnsForwarderFailure,
  type HnsForwarderGatewayEnvelopeV1,
  type HnsForwarderGatewayInputV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import {
  admitHnsCommunityHandleGatewayRequest,
  type HnsCommunityHandleGatewayAdmission,
} from "./handle-request.ts";
import {
  HnsCommunityHandleGatewayUpstreamError,
  sanitizeHnsCommunityHandleGatewayResponse,
} from "./handle-response.ts";
import type { HnsStaticPlatformGatewayRequest } from "./request.ts";

export type HnsCommunityHandleGatewayFetch = (request: Request) => Promise<Response> | Response;
export type HnsCommunityHandleGatewaySigner = Readonly<{
  sign: (input: HnsForwarderGatewayInputV1) => Promise<HnsForwarderGatewayEnvelopeV1>;
}>;
export type HnsCommunityHandleGatewayService = Readonly<{
  handle: (request: HnsStaticPlatformGatewayRequest) => Promise<Response>;
}>;

type GatewayTimer = ReturnType<typeof setTimeout>;
type GatewaySetTimeout = (callback: () => void, delay: number) => GatewayTimer;
type GatewayClearTimeout = (timer: GatewayTimer) => void;

export class HnsCommunityHandleGatewayCallerAbort extends Error {
  readonly name = "HnsCommunityHandleGatewayCallerAbort";
}

class HnsCommunityHandleGatewayTerminal extends Error {
  readonly name = "HnsCommunityHandleGatewayTerminal";
}

function redacted(status: number, allow?: string): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (allow !== undefined) headers.set("allow", allow);
  return new Response(null, { status, headers });
}

function authorityMatches(
  envelope: HnsForwarderGatewayEnvelopeV1,
  admitted: HnsCommunityHandleGatewayAdmission,
  deploymentReference: string,
): boolean {
  const state = envelope.authority.state;
  return (
    envelope.authority.normalized_host === admitted.normalized_host &&
    envelope.authority.canonical_root === admitted.canonical_root &&
    envelope.authority.host_authority[0] === "handle_persona_v1" &&
    state.variant === "handle_persona_v1" &&
    state.normalized_host === admitted.normalized_host &&
    state.canonical_root === admitted.canonical_root &&
    state.canonical_handle_label === admitted.canonical_handle_label &&
    state.fulfillment_kind === "hosted_persona_v1" &&
    state.sale_namespace_gateway_deployment_reference === deploymentReference &&
    state.dns_zone.gateway_deployment_reference === deploymentReference
  );
}

function signerFailureResponse(error: unknown): Response {
  if (!(error instanceof HnsForwarderFailure)) return redacted(503);
  if (error.reason === "body_too_large") return redacted(413);
  if (error.reason === "invalid_request") return redacted(400);
  if (error.reason === "authority_not_found") return redacted(421);
  if (error.reason === "authority_unavailable") return redacted(503);
  return redacted(503);
}

export function makeHnsCommunityHandleGatewayService(input: {
  signer: HnsCommunityHandleGatewaySigner;
  gateway_deployment_reference: string;
  solid_origin: string;
  solid_access_client_id: string;
  solid_access_client_secret: string;
  upstream_fetch: HnsCommunityHandleGatewayFetch;
  set_timeout?: GatewaySetTimeout;
  clear_timeout?: GatewayClearTimeout;
}): HnsCommunityHandleGatewayService {
  const setTimer = input.set_timeout ?? setTimeout;
  const clearTimer = input.clear_timeout ?? clearTimeout;

  return Object.freeze({
    handle: async (request) => {
      const admitted = admitHnsCommunityHandleGatewayRequest(request);
      if ("status" in admitted) return redacted(admitted.status, admitted.allow);

      const controller = new AbortController();
      let terminal: "caller" | "deadline" | null = null;
      let rejectTerminal: ((error: HnsCommunityHandleGatewayTerminal) => void) | null = null;
      const terminalPromise = new Promise<never>((_resolve, reject) => {
        rejectTerminal = reject;
      });
      const selectTerminal = (next: "caller" | "deadline") => {
        if (terminal !== null) return;
        terminal = next;
        controller.abort();
        rejectTerminal?.(new HnsCommunityHandleGatewayTerminal());
      };
      const abortFromCaller = () => selectTerminal("caller");
      if (request.signal.aborted) throw new HnsCommunityHandleGatewayCallerAbort();
      request.signal.addEventListener("abort", abortFromCaller, { once: true });
      const timer = setTimer(
        () => selectTerminal("deadline"),
        HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[14],
      );

      try {
        let envelope: HnsForwarderGatewayEnvelopeV1;
        try {
          envelope = await Promise.race([
            input.signer.sign({
              method: admitted.method,
              normalized_host: admitted.normalized_host,
              path_and_query: "/",
              headers: new Headers(),
              body_bytes: new Uint8Array(),
            }),
            terminalPromise,
          ]);
        } catch (error) {
          if (terminal === "caller") throw new HnsCommunityHandleGatewayCallerAbort();
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
          upstreamHeaders.set("cf-access-client-id", input.solid_access_client_id);
          upstreamHeaders.set("cf-access-client-secret", input.solid_access_client_secret);
          upstream = await Promise.race([
            Promise.resolve(
              input.upstream_fetch(
                new Request(`${input.solid_origin}/`, {
                  method: admitted.method,
                  headers: upstreamHeaders,
                  redirect: "manual",
                  signal: controller.signal,
                }),
              ),
            ),
            terminalPromise,
          ]);
        } catch {
          if (terminal === "caller") throw new HnsCommunityHandleGatewayCallerAbort();
          return redacted(terminal === "deadline" ? 504 : 503);
        }
        if (terminal === "caller") throw new HnsCommunityHandleGatewayCallerAbort();
        if (terminal === "deadline") {
          await upstream.body?.cancel().catch(() => undefined);
          return redacted(504);
        }
        try {
          const sanitized = await Promise.race([
            sanitizeHnsCommunityHandleGatewayResponse(upstream, admitted.method),
            terminalPromise,
          ]);
          if (terminal === "caller") throw new HnsCommunityHandleGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          return sanitized;
        } catch (error) {
          if (terminal === "caller") throw new HnsCommunityHandleGatewayCallerAbort();
          if (terminal === "deadline") return redacted(504);
          if (error instanceof HnsCommunityHandleGatewayUpstreamError) {
            console.error(
              JSON.stringify({
                event: "hns_community_handle_gateway_upstream_refused",
                reason: error.reason,
              }),
            );
          }
          return redacted(error instanceof HnsCommunityHandleGatewayUpstreamError ? 502 : 503);
        }
      } finally {
        clearTimer(timer);
        request.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  });
}
