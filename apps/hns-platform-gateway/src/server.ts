import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import type { HnsStaticPlatformGatewayComposition } from "./composition.ts";
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
  for (const [name, value] of webResponse.headers) response.setHeader(name, value);
  if (webResponse.body === null) {
    response.end();
    return;
  }
  response.end(new Uint8Array(await webResponse.arrayBuffer()));
}

function gatewayHandler(service: HnsStaticPlatformGatewayService) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    const clientClosed = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once("close", clientClosed);
    try {
      const result = await service.handle({
        method: request.method ?? "",
        target: request.url ?? "",
        header_fields: rawHeaderFields(request),
        body_bytes: new Uint8Array(),
        signal: abort.signal,
      });
      if (!response.destroyed) await writeResponse(response, result);
    } catch (error) {
      if (!(error instanceof HnsStaticPlatformGatewayCallerAbort) && !response.destroyed) {
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
  if (
    !input.composition.enabled ||
    !validLoopbackAddress(input.gateway_host) ||
    !validLoopbackAddress(input.health_host) ||
    !validPort(input.gateway_port) ||
    !validPort(input.health_port) ||
    (input.gateway_host === input.health_host &&
      input.gateway_port !== 0 &&
      input.gateway_port === input.health_port)
  ) {
    throw new Error("HNS static platform gateway server configuration is incomplete or invalid");
  }

  const gateway = createServer(gatewayHandler(input.composition.service));
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
