import { createConnection, createServer, type Socket } from "node:net";
// Plain local protocol proxy for a single owned connection. It observes the
// real backend COMMIT tag and idle ReadyForQuery, then destroys only this pair
// before forwarding those acknowledgments. No PostgreSQL/provider side effects
// are inferred from a timeout, and no production connection may be used here.
export async function commitAckDropProxy(upstreamUrl: string) {
  const parsed = new URL(upstreamUrl);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("COMMIT fault fixture requires owned loopback PostgreSQL");
  // Preserve upstream address before rewriting the returned proxy URL.
  const upstreamHost = parsed.hostname;
  const upstreamPort = Number(parsed.port || "5432");
  const sockets = new Set<Socket>();
  let armed = false;
  let sawCommit = false;
  let sawIdle = false;
  const server = createServer((downstream) => {
    const upstream = createConnection({
      host: upstreamHost,
      port: upstreamPort,
    });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => upstream.destroy());
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.pipe(upstream);
    let pending = Buffer.alloc(0);
    upstream.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (length < 4 || length > 16 * 1024 * 1024) {
          downstream.destroy();
          upstream.destroy();
          return;
        }
        if (pending.length < length + 1) return;
        const frame = pending.subarray(0, length + 1);
        pending = pending.subarray(length + 1);
        if (armed && frame[0] === 0x43 && frame.subarray(5).toString("utf8") === "COMMIT\0") {
          sawCommit = true;
          continue;
        }
        if (armed && sawCommit && frame[0] === 0x5a && frame[5] === 0x49) {
          sawIdle = true;
          downstream.destroy();
          upstream.destroy();
          return;
        }
        downstream.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy address missing");
  parsed.hostname = "127.0.0.1";
  parsed.port = String(address.port);
  parsed.searchParams.set("sslmode", "disable");
  return {
    connectionString: parsed.toString(),
    arm: () => {
      armed = true;
    },
    observed: () => ({ sawCommit, sawIdle }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
