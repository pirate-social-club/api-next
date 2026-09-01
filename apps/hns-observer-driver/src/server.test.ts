import { describe, expect, test } from "bun:test";
import {
  encodeHnsPrivateDriverRequestV1,
  HNS_PRIVATE_DRIVER_HSD_PATH,
  HNS_PRIVATE_DRIVER_ORIGIN,
  HNS_PRIVATE_DRIVER_PROTOCOL,
  HNS_PRIVATE_DRIVER_PROTOCOL_HEADER,
} from "@pirate/application/namespace-ownership";
import { makeHnsObserverDriverOrigin } from "./server.ts";

const environment = {
  HNS_OBSERVER_DRIVER_HSD_REFERENCE: "hsd-json-rpc:production-primary",
  HNS_OBSERVER_DRIVER_HSD_RPC_URL: "http://127.0.0.1:12037/",
  HNS_OBSERVER_DRIVER_HSD_API_KEY_FILE: "/run/credentials/driver/hsd_api_key",
  HNS_OBSERVER_DRIVER_PORT: "4081",
} as const;

function request(): Request {
  return new Request(`${HNS_PRIVATE_DRIVER_ORIGIN}${HNS_PRIVATE_DRIVER_HSD_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/octet-stream",
      [HNS_PRIVATE_DRIVER_PROTOCOL_HEADER]: HNS_PRIVATE_DRIVER_PROTOCOL,
    },
    body: encodeHnsPrivateDriverRequestV1({
      exchange_kind: "hsd_json_rpc",
      driver_reference: "hsd-json-rpc:production-primary",
      request_bytes: new TextEncoder().encode('{"method":"getblockchaininfo","params":[]}'),
      response_max_bytes: 1_048_576,
      timeout_ms: 2_000,
    }),
  });
}

describe("HNS observer driver origin", () => {
  test("closes the production origin over loopback HSD and a credential file", async () => {
    const upstream: Request[] = [];
    const origin = await makeHnsObserverDriverOrigin({
      environment,
      read_credential: async (path) => {
        expect(path).toBe(environment.HNS_OBSERVER_DRIVER_HSD_API_KEY_FILE);
        return "private-rpc-key\n";
      },
      fetcher: async (input) => {
        upstream.push(input as Request);
        return new Response('{"result":{"chain":"main"},"error":null,"id":null}', {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect(origin.hostname).toBe("127.0.0.1");
    expect(origin.port).toBe(4_081);
    const response = await origin.fetch(request());
    expect(response.status).toBe(200);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.url).toBe(environment.HNS_OBSERVER_DRIVER_HSD_RPC_URL);
    expect(upstream[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("x:private-rpc-key").toString("base64")}`,
    );
  });

  test("rejects a non-loopback HSD endpoint and malformed credential", async () => {
    await expect(
      makeHnsObserverDriverOrigin({
        environment: { ...environment, HNS_OBSERVER_DRIVER_HSD_RPC_URL: "https://hsd.invalid/" },
        read_credential: async () => "private-rpc-key",
      }),
    ).rejects.toThrow();
    await expect(
      makeHnsObserverDriverOrigin({
        environment,
        read_credential: async () => "contains whitespace",
      }),
    ).rejects.toThrow();
  });
});
