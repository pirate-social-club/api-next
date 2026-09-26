import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { connectHnsGatewayTlsV1, hnsGatewayReadinessStatusV1 } from "./live-readiness.ts";

describe("live HNS root readiness", () => {
  test("accepts a routed app host and an unclaimed-label gateway response", () => {
    expect(hnsGatewayReadinessStatusV1("HTTP/1.1 200 OK")).toBe(200);
    expect(hnsGatewayReadinessStatusV1("HTTP/1.1 421 Misdirected Request")).toBe(421);
  });

  test("refuses malformed and unhealthy gateway status lines", () => {
    expect(() => hnsGatewayReadinessStatusV1("HTTP/2 200")).toThrow();
    expect(() => hnsGatewayReadinessStatusV1("HTTP/1.1 503 Service Unavailable")).toThrow();
  });

  test("opens a TLS connection from the pinned source address", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hns-gateway-tls-"));
    const key = join(directory, "key.pem");
    const certificate = join(directory, "certificate.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-keyout",
        key,
        "-out",
        certificate,
      ],
      { stdio: "ignore" },
    );
    const server = createServer(
      { key: readFileSync(key), cert: readFileSync(certificate) },
      (socket) =>
        socket.once("data", () =>
          socket.end("HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\n\r\n"),
        ),
    );
    let client: ReturnType<typeof connectHnsGatewayTlsV1> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      client = connectHnsGatewayTlsV1({
        gateway_address: "127.0.0.1",
        gateway_local_address: "127.0.0.1",
        servername: "app.staging-root",
        port: address.port,
      });
      const connected = client;
      const response = await new Promise<string>((resolve, reject) => {
        connected.once("error", reject);
        connected.once("secureConnect", () =>
          connected.write("GET / HTTP/1.1\r\nHost: app.staging-root\r\nConnection: close\r\n\r\n"),
        );
        connected.once("data", (chunk) => resolve(chunk.toString()));
      });
      expect(connected.localAddress).toBe("127.0.0.1");
      expect(hnsGatewayReadinessStatusV1(response.split("\r\n")[0] ?? "")).toBe(421);
    } finally {
      client?.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
