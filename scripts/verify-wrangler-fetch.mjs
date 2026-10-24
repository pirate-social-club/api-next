#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { gzipSync } from "node:zlib";

// This tests the embedded CLI fetch, rather than a separately resolved Undici.
assert(!process.versions.bun, "Run this regression with native Node.js");
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const packageRoot = dirname(require.resolve("wrangler/package.json"));
const wranglerRequire = createRequire(join(packageRoot, "package.json"));
for (const dependency of ["esbuild", "miniflare"]) wranglerRequire.resolve(dependency);
const cli = join(packageRoot, "wrangler-dist/cli.js");
const originalHash = "54f9ac65c8136f81ee4695844be67c37d543b40f3f6486f4234e2dce92b14a7d";
const patchedHash = "e832d95232c2fbc1f5eb0ef427676c8d3be87c68911da9ff38bf55949a4c4ee0";
const patchHash = "15b9cbcb09c14b5d9fb10a80d8b446af28345fe990aff73311f8b43b147685b4";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installed = await readFile(cli);
assert.equal(
  JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version,
  "4.123.0",
);
assert.equal(
  digest(installed),
  patchedHash,
  "Installed Wrangler bundle differs from reviewed backport",
);
assert.equal(digest(await readFile(join(root, "patches/wrangler@4.123.0.patch"))), patchHash);

// Reconstruct the exact unchanged npm bundle for the negative control. Hashing
// the whole result refuses additional mutations, including a partial backport.
let original = installed.toString();
for (const [resume, request, annotation, onError] of [
  ["resume", "request4", "", "onError"],
  ["resume$1", "request$1", "/* @__PURE__ */ ", "onError$1"],
]) {
  const stream = `              this.body = new Readable13({ read: ${resume} });\n`;
  const late = `${stream}              const ${onError} = this.onError.bind(this);`;
  const follow = `              const willFollow = location && ${request}.redirect`;
  const abort = `                  this.abort(${annotation}new Error(\`too many content-encodings in response: \${codings.length}, maximum allowed is \${maxContentEncodings}\`));`;
  for (const expected of [late, follow, abort]) assert.equal(original.split(expected).length, 2);
  original = original
    .replace(late, `              const ${onError} = this.onError.bind(this);`)
    .replace(follow, stream + follow)
    .replace(abort, abort.replace("this.abort(", "reject("));
}
assert.equal(digest(original), originalHash, "Negative control must be the exact unchanged bundle");

const scratch = await mkdtemp(join(tmpdir(), "wrangler-fetch-"));
const account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const expectedPath = `/client/v4/accounts/${account}/d1/database?per_page=10&page=1`;
const databases = [{ uuid: "11111111-1111-4111-8111-111111111111", name: "fixture" }];
const response = Buffer.from(
  JSON.stringify({ success: true, errors: [], messages: [], result: databases }),
);
const results = [];
function stop(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
try {
  const originalCli = join(scratch, "original-cli.cjs");
  await writeFile(originalCli, original);
  const monitor = join(scratch, "uncaught-monitor.cjs");
  // Node's monitor event observes uncaught exceptions without handling them.
  // Wrangler installs its own reporter, so native stderr formatting is not a
  // reliable witness. This observer neither replaces fetch nor changes exit.
  await writeFile(
    monitor,
    `process.on("uncaughtExceptionMonitor", (error, origin) => {
    process.stderr.write("WRANGLER_FETCH_UNCAUGHT:" + JSON.stringify({
      name: error.name, code: error.code ?? null, origin
    }) + "\\n");
  });\n`,
  );
  await writeFile(
    join(scratch, "wrangler.jsonc"),
    JSON.stringify({ name: "fetch-fixture", send_metrics: false }),
  );
  for (const [label, executable] of [
    ["original", originalCli],
    ["patched", cli],
  ]) {
    for (const kind of ["json", "gzip", "hostile"]) {
      const sockets = new Set();
      const requests = [];
      let invalidRequest = false;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setTimeout(5000, () => socket.destroy());
        let request = "";
        socket.on("data", (chunk) => {
          request += chunk.toString("latin1");
          if (request.length > 8192) return socket.destroy();
          if (!request.includes("\r\n\r\n")) return;
          socket.removeAllListeners("data");
          const firstLine = request.split("\r\n", 1)[0];
          if (requests.length >= 1) {
            invalidRequest = true;
            socket.destroy();
            return;
          }
          requests.push(firstLine);
          if (
            firstLine !== `GET ${expectedPath} HTTP/1.1` ||
            !request.toLowerCase().includes("authorization: bearer fixture-token\r\n")
          ) {
            invalidRequest = true;
            socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
          }
          if (kind === "hostile") {
            socket.end(
              "HTTP/1.1 200 OK\r\nContent-Encoding: gzip,gzip,gzip,gzip,gzip,gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
            );
          } else {
            const body = kind === "gzip" ? gzipSync(response) : response;
            const encoding = kind === "gzip" ? "Content-Encoding: gzip\r\n" : "";
            socket.end(
              Buffer.concat([
                Buffer.from(
                  `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${encoding}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
                ),
                body,
              ]),
            );
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const started = Date.now();
      let child;
      let timeout;
      try {
        const { port } = server.address();
        const env = {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          CI: "true",
          NO_COLOR: "1",
          XDG_CONFIG_HOME: join(scratch, `config-${label}-${kind}`),
          NODE_PATH: [dirname(packageRoot), join(root, "node_modules")].join(delimiter),
          CLOUDFLARE_ACCOUNT_ID: account,
          CLOUDFLARE_API_TOKEN: "fixture-token",
          CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${port}/client/v4`,
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(scratch, `${label}-${kind}.log`),
        };
        child = spawn(
          process.execPath,
          [
            "--require",
            monitor,
            executable,
            "d1",
            "list",
            "--json",
            "--config",
            join(scratch, "wrangler.jsonc"),
          ],
          { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
        );
        let stdout = "";
        let stderr = "";
        let bounded = true;
        const collect = (which, chunk) => {
          if (!bounded) return;
          const remaining = 262144 - stdout.length - stderr.length;
          const text = chunk.toString();
          if (which === "stdout") stdout += text.slice(0, remaining);
          else stderr += text.slice(0, remaining);
          if (text.length > remaining) {
            bounded = false;
            stop(child);
          }
        };
        child.stdout.on("data", (chunk) => collect("stdout", chunk));
        child.stderr.on("data", (chunk) => collect("stderr", chunk));
        let timedOut = false;
        timeout = setTimeout(() => {
          timedOut = true;
          stop(child);
        }, 20000);
        const exit = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        results.push({
          label,
          kind,
          ...exit,
          duration_ms: Date.now() - started,
          requests,
          stdout,
          stderr,
        });
        assert(
          !timedOut && bounded && !invalidRequest,
          "Child exceeded bounds or used an unexpected fixture request",
        );
        assert.equal(requests.length, 1, "Expected exactly one real CLI fixture request");
        assert.equal(exit.signal, null, "A signal-killed child is never a successful proof");
        const diagnostic = stripVTControlCharacters(stderr);
        const uncaught = diagnostic
          .split("\n")
          .filter((line) => line.startsWith("WRANGLER_FETCH_UNCAUGHT:"))
          .map((line) => JSON.parse(line.slice("WRANGLER_FETCH_UNCAUGHT:".length)));
        const unhandled =
          uncaught.length > 0 ||
          /Unhandled 'error' event|Emitted 'error' event on Readable/.test(diagnostic);
        if (kind !== "hostile") {
          assert.equal(exit.code, 0, `${label}/${kind} control failed: ${stderr}`);
          assert.deepEqual(JSON.parse(stdout), databases);
          assert(!unhandled);
        } else if (label === "original") {
          assert(unhandled, "Original CLI did not reproduce the advisory's orphaned-stream error");
          assert(
            uncaught.some(
              (error) =>
                error.origin === "uncaughtException" &&
                error.code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
            ),
            "Original CLI must expose the specific uncaught response-length mismatch",
          );
          assert.equal(exit.code, 1);
        } else {
          assert(!unhandled, `Patched CLI emitted an unhandled stream error: ${stderr}`);
          assert.equal(exit.code, 1, "Malformed response must be refused normally");
          assert(
            /\[ERROR\]\s+(?:fetch failed|too many content-encodings)/.test(diagnostic),
            "Expected Wrangler's handled-error diagnostic for the fixture failure",
          );
          assert(
            !/triggerUncaughtException|^node:(?:events|internal\/process\/promises):\d|^FATAL ERROR:|^TypeError: fetch failed|^Node\.js v\d/m.test(
              diagnostic,
            ),
            "Native uncaught or fatal output is never a successful patched proof",
          );
        }
      } finally {
        clearTimeout(timeout);
        if (child?.exitCode === null && child.signalCode === null) stop(child);
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
  console.log(
    JSON.stringify({ complete: true, originalHash, patchedHash, patchHash, results }, null, 2),
  );
} catch (error) {
  console.log(JSON.stringify({ complete: false, results, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
