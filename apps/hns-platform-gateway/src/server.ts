import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import { HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE } from "@pirate/application/hns-community-app-gateway";
import { HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE } from "@pirate/application/hns-community-handle-gateway";
import { HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE } from "@pirate/application/hns-static-platform-app-gateway";
import type {
  HnsCommunityAppHandleGatewayComposition,
  HnsCommunityAppHandleGatewayService,
} from "./combined-composition.ts";
import type { HnsCommunityAppGatewayComposition } from "./community-composition.ts";
import {
  HnsCommunityAppGatewayCallerAbort,
  type HnsCommunityAppGatewayService,
} from "./community-service.ts";
import type { HnsStaticPlatformGatewayComposition } from "./composition.ts";
import type { HnsCommunityHandleGatewayComposition } from "./handle-composition.ts";
import {
  HnsCommunityHandleGatewayCallerAbort,
  type HnsCommunityHandleGatewayService,
} from "./handle-service.ts";
import { makeHnsStaticPlatformGatewayHealthService } from "./health.ts";
import {
  HnsStaticPlatformGatewayCallerAbort,
  type HnsStaticPlatformGatewayService,
} from "./service.ts";

export type HnsStaticPlatformGatewayServer = Readonly<{
  gateway_address: Readonly<{ host: string; port: number }>;
  health_address: Readonly<{ host: string; port: number }>;
  stop: () => Promise<void>;
}>;

export type HnsCommunityAppGatewayServer = HnsStaticPlatformGatewayServer;
export type HnsCommunityHandleGatewayServer = HnsStaticPlatformGatewayServer;
export type HnsCommunityAppHandleGatewayServer = HnsStaticPlatformGatewayServer;

type HnsLoopbackGatewayService =
  | HnsStaticPlatformGatewayService
  | HnsCommunityAppGatewayService
  | HnsCommunityHandleGatewayService
  | HnsCommunityAppHandleGatewayService;

function validLoopbackAddress(host: string): boolean {
  const family = isIP(host);
  return (family === 4 && host.startsWith("127.")) || (family === 6 && host === "::1");
}

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535;
}

function rawHeaderFields(request: IncomingMessage): readonly (readonly [string, string])[] {
  const fields: Array<readonly [string, string]> = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    fields.push([request.rawHeaders[index] ?? "", request.rawHeaders[index + 1] ?? ""]);
  }
  return fields;
}

async function writeResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  for (const [name, value] of webResponse.headers) {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  }
  const setCookies = (
    webResponse.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();
  if (setCookies !== undefined && setCookies.length > 0)
    response.setHeader("set-cookie", setCookies);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  response.end(new Uint8Array(await webResponse.arrayBuffer()));
}

function readBoundedRequestBody(
  request: IncomingMessage,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (body: Uint8Array) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        request.pause();
        finish(new Uint8Array(maximumBytes + 1));
        return;
      }
      chunks.push(new Uint8Array(chunk));
    };
    const onEnd = () => {
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      finish(body);
    };
    const onError = () => fail(new Error("Request body is invalid"));
    const onAbort = () => fail(new HnsStaticPlatformGatewayCallerAbort());

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
  });
}

function gatewayHandler(service: HnsLoopbackGatewayService, maximumRequestBodyBytes: number) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const clientClosed = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once("close", clientClosed);
    try {
      const bodyBytes = await readBoundedRequestBody(
        request,
        abort.signal,
        maximumRequestBodyBytes,
      );
      const result = await service.handle({
        method: request.method ?? "",
        target: request.url ?? "",
        header_fields: rawHeaderFields(request),
        body_bytes: bodyBytes,
        signal: abort.signal,
      });
      if (!response.destroyed) await writeResponse(response, result);
    } catch (error) {
      if (
        !(error instanceof HnsStaticPlatformGatewayCallerAbort) &&
        !(error instanceof HnsCommunityAppGatewayCallerAbort) &&
        !(error instanceof HnsCommunityHandleGatewayCallerAbort) &&
        !response.destroyed
      ) {
        await writeResponse(response, new Response(null, { status: 503 }));
      }
    } finally {
      response.off("close", clientClosed);
      request.resume();
    }
  };
}

function healthHandler(ready: () => Promise<boolean> | boolean) {
  const service = makeHnsStaticPlatformGatewayHealthService({ ready });
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const result =
      request.method === "GET" || request.method === "HEAD"
        ? await service.handle(request.url ?? "")
        : new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    await writeResponse(response, result);
  };
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, host, () => {
      server.off("error", failed);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HNS static platform gateway listener address is invalid"));
        return;
      }
      resolve(address);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections?.();
  });
}

export async function startHnsStaticPlatformGatewayServer(input: {
  composition: HnsStaticPlatformGatewayComposition;
  gateway_host: string;
  gateway_port: number;
  health_host: string;
  health_port: number;
  ready: () => Promise<boolean> | boolean;
}): Promise<HnsStaticPlatformGatewayServer> {
  if (!input.composition.enabled) {
    throw new Error("HNS static platform gateway server configuration is incomplete or invalid");
  }
  return startLoopbackGatewayServer({
    service: input.composition.service,
    gateway_host: input.gateway_host,
    gateway_port: input.gateway_port,
    health_host: input.health_host,
    health_port: input.health_port,
    ready: input.ready,
    maximum_request_body_bytes: HNS_STATIC_PLATFORM_APP_GATEWAY_PROFILE[11],
    invalid_configuration_message:
      "HNS static platform gateway server configuration is incomplete or invalid",
  });
}

export async function startHnsCommunityAppGatewayServer(input: {
  composition: HnsCommunityAppGatewayComposition;
  gateway_host: string;
  gateway_port: number;
  health_host: string;
  health_port: number;
  ready: () => Promise<boolean> | boolean;
}): Promise<HnsCommunityAppGatewayServer> {
  if (!input.composition.enabled) {
    throw new Error("HNS community app gateway server configuration is incomplete or invalid");
  }
  return startLoopbackGatewayServer({
    service: input.composition.service,
    gateway_host: input.gateway_host,
    gateway_port: input.gateway_port,
    health_host: input.health_host,
    health_port: input.health_port,
    ready: input.ready,
    maximum_request_body_bytes: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11],
    invalid_configuration_message:
      "HNS community app gateway server configuration is incomplete or invalid",
  });
}

export async function startHnsCommunityHandleGatewayServer(input: {
  composition: HnsCommunityHandleGatewayComposition;
  gateway_host: string;
  gateway_port: number;
  health_host: string;
  health_port: number;
  ready: () => Promise<boolean> | boolean;
}): Promise<HnsCommunityHandleGatewayServer> {
  if (!input.composition.enabled) {
    throw new Error("HNS community handle gateway server configuration is incomplete or invalid");
  }
  return startLoopbackGatewayServer({
    service: input.composition.service,
    gateway_host: input.gateway_host,
    gateway_port: input.gateway_port,
    health_host: input.health_host,
    health_port: input.health_port,
    ready: input.ready,
    maximum_request_body_bytes: HNS_COMMUNITY_HANDLE_PERSONA_GATEWAY_PROFILE[12],
    invalid_configuration_message:
      "HNS community handle gateway server configuration is incomplete or invalid",
  });
}

export async function startHnsCommunityAppHandleGatewayServer(input: {
  composition: HnsCommunityAppHandleGatewayComposition;
  gateway_host: string;
  gateway_port: number;
  health_host: string;
  health_port: number;
  ready: () => Promise<boolean> | boolean;
}): Promise<HnsCommunityAppHandleGatewayServer> {
  if (!input.composition.enabled) {
    throw new Error(
      "HNS community app-handle gateway server configuration is incomplete or invalid",
    );
  }
  return startLoopbackGatewayServer({
    service: input.composition.service,
    gateway_host: input.gateway_host,
    gateway_port: input.gateway_port,
    health_host: input.health_host,
    health_port: input.health_port,
    ready: input.ready,
    maximum_request_body_bytes: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11],
    invalid_configuration_message:
      "HNS community app-handle gateway server configuration is incomplete or invalid",
  });
}

async function startLoopbackGatewayServer(input: {
  service: HnsLoopbackGatewayService;
  gateway_host: string;
  gateway_port: number;
  health_host: string;
  health_port: number;
  ready: () => Promise<boolean> | boolean;
  maximum_request_body_bytes: number;
  invalid_configuration_message: string;
}): Promise<HnsStaticPlatformGatewayServer> {
  if (
    !validLoopbackAddress(input.gateway_host) ||
    !validLoopbackAddress(input.health_host) ||
    !validPort(input.gateway_port) ||
    !validPort(input.health_port) ||
    (input.gateway_host === input.health_host &&
      input.gateway_port !== 0 &&
      input.gateway_port === input.health_port)
  ) {
    throw new Error(input.invalid_configuration_message);
  }

  const gateway = createServer(gatewayHandler(input.service, input.maximum_request_body_bytes));
  const health = createServer(healthHandler(input.ready));
  let gatewayAddress: AddressInfo | null = null;
  try {
    gatewayAddress = await listen(gateway, input.gateway_host, input.gateway_port);
    const healthAddress = await listen(health, input.health_host, input.health_port);
    return Object.freeze({
      gateway_address: Object.freeze({ host: gatewayAddress.address, port: gatewayAddress.port }),
      health_address: Object.freeze({ host: healthAddress.address, port: healthAddress.port }),
      stop: async () => {
        await Promise.all([close(gateway), close(health)]);
      },
    });
  } catch (error) {
    if (gatewayAddress !== null) await close(gateway).catch(() => undefined);
    await close(health).catch(() => undefined);
    throw error;
  }
}
