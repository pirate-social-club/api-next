import { isAbsolute } from "node:path";
import { HnsObserverDriverExchangeError } from "@pirate/hns-dns-runtime/dns-tcp";
import {
  type HnsObserverDriverHttpFetch,
  makeHnsObserverDriverHsdHttpCapability,
} from "./hsd-http.ts";
import { type HnsObserverDriverService, makeHnsObserverDriverService } from "./service.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type HnsObserverDriverOrigin = HnsObserverDriverService &
  Readonly<{
    hostname: "127.0.0.1";
    port: number;
  }>;

function required(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  return value;
}

function validDriverReference(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}:[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value);
}

function hsdEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  return url.toString();
}

function listenPort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  return port;
}

async function defaultReadCredential(path: string): Promise<string> {
  const file = Bun.file(path);
  if ((await file.exists()) !== true || file.size > 1_024) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  return await file.text();
}

export async function makeHnsObserverDriverOrigin(input: {
  readonly environment: Environment;
  readonly read_credential?: (path: string) => Promise<string>;
  readonly fetcher?: HnsObserverDriverHttpFetch;
}): Promise<HnsObserverDriverOrigin> {
  const driverReference = required(input.environment, "HNS_OBSERVER_DRIVER_HSD_REFERENCE");
  const credentialPath = required(input.environment, "HNS_OBSERVER_DRIVER_HSD_API_KEY_FILE");
  if (!validDriverReference(driverReference) || !isAbsolute(credentialPath)) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const apiKey = (await (input.read_credential ?? defaultReadCredential)(credentialPath)).trim();
  if (
    apiKey.length === 0 ||
    new TextEncoder().encode(apiKey).byteLength > 512 ||
    [...apiKey].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 0x21 || (point >= 0x7f && point <= 0x9f);
    })
  ) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const service = makeHnsObserverDriverService({
    hsd_driver_reference: driverReference,
    hsd: makeHnsObserverDriverHsdHttpCapability({
      endpoint: hsdEndpoint(required(input.environment, "HNS_OBSERVER_DRIVER_HSD_RPC_URL")),
      authorization: `Basic ${Buffer.from(`x:${apiKey}`, "utf8").toString("base64")}`,
      fetcher: input.fetcher ?? fetch,
    }),
    dns_views: [],
  });
  return Object.freeze({
    hostname: "127.0.0.1" as const,
    port: listenPort(required(input.environment, "HNS_OBSERVER_DRIVER_PORT")),
    fetch: service.fetch,
  });
}

async function main(): Promise<void> {
  if (Bun.argv.length !== 2) {
    throw new HnsObserverDriverExchangeError("upstream_protocol_error");
  }
  const origin = await makeHnsObserverDriverOrigin({ environment: process.env });
  const server = Bun.serve({ hostname: origin.hostname, port: origin.port, fetch: origin.fetch });
  const stop = () => server.stop(false);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(JSON.stringify({ event: "hns_observer_driver_ready", port: origin.port }));
}

if (import.meta.main) {
  main().catch(() => {
    console.error("HNS observer driver failed");
    process.exitCode = 1;
  });
}
