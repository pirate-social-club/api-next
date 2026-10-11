import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const script = fileURLToPath(new URL("./read-only-hsd-rpc-production.mjs", import.meta.url));

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("production reader loads both systemd credentials and refuses write RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hns-production-reader-"));
  const port = await availablePort();
  const clientKey = "test-client-key";
  await writeFile(join(directory, "production-hsd-client-key"), `${clientKey}\n`);
  await writeFile(join(directory, "production-hsd-upstream-key"), "test-upstream-key\n");
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, CREDENTIALS_DIRECTORY: directory, HNS_READER_LISTEN_PORT: String(port) },
    stdio: "ignore",
  });
  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (child.exitCode !== null) throw new Error("Production reader exited before readiness");
      try {
        response = await fetch(`http://127.0.0.1:${port}/`, {
          method: "POST",
          headers: { authorization: `Basic ${Buffer.from(`x:${clientKey}`).toString("base64")}` },
          body: JSON.stringify({ method: "sendrawtransaction", params: ["00"] }),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(response?.status, 403);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
});
