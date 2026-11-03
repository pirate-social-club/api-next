import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type get, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const root = createRequire(new URL("../package.json", import.meta.url));
const core = createRequire(root.resolve("@selfxyz/core"));
const common = createRequire(core.resolve("@selfxyz/common"));
const snarkjs = createRequire(core.resolve("snarkjs"));
const ejs = createRequire(snarkjs.resolve("ejs"));
const jake = createRequire(ejs.resolve("jake"));
const filelist = createRequire(jake.resolve("filelist"));

interface FileListInstance {
  include(...values: (string | { dot?: boolean; nocase?: boolean })[]): FileListInstance;
  exclude(pattern: string): FileListInstance;
  toArray(): string[];
}

test("filelist's installed CommonJS match handles braces, recursion, exclusions, extglobs and dotfiles", async () => {
  const minimatch = filelist("minimatch") as {
    match: (files: string[], pattern: string) => string[];
  };
  expect(filelist("minimatch/package.json").version).toBe("11.0.1");
  const minimatchLoader = createRequire(filelist.resolve("minimatch"));
  expect(minimatchLoader("brace-expansion/package.json").version).toBe("5.0.12");
  expect(minimatch.match(["a.txt", "b.ts", "c.js"], "*.{txt,ts}")).toEqual(["a.txt", "b.ts"]);
  const { FileList } = jake("filelist") as { FileList: new () => FileListInstance };
  const fixture = await mkdtemp(join(tmpdir(), "pirate-filelist-compatibility-"));
  try {
    await mkdir(join(fixture, "nested"));
    for (const path of ["a.txt", "b.ts", "c.js", ".hidden.txt", "UPPER.TXT", "nested/d.txt"]) {
      await writeFile(join(fixture, path), "synthetic\n");
    }
    const relative = (files: string[]) =>
      files.map((path) => path.slice(fixture.length + 1)).sort();
    expect(
      relative(
        new FileList().include(`${fixture}/**/*.{txt,ts}`).exclude(`${fixture}/b.ts`).toArray(),
      ),
    ).toEqual(["a.txt", "nested/d.txt"]);
    expect(
      relative(
        new FileList().include(`${fixture}/**/*.txt`, { dot: true, nocase: true }).toArray(),
      ),
    ).toEqual([".hidden.txt", "UPPER.TXT", "a.txt", "nested/d.txt"]);
    expect(relative(new FileList().include(`${fixture}/+(a|b).*`).toArray())).toEqual([
      "a.txt",
      "b.ts",
    ]);
    expect(new FileList().include(`${fixture}/missing/**/*.txt`).toArray()).toEqual([]);
  } finally {
    // Exact directory created by this test; no application data is involved.
    await rm(fixture, { recursive: true });
  }
});

const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
};
const close = async (server: Server) => {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
};

test("follow-redirects drops a cross-realm custom credential on a real cross-origin redirect", async () => {
  const axios = createRequire(common.resolve("axios"));
  expect(axios("follow-redirects/package.json").version).toBe("1.16.2");
  const follow = axios("follow-redirects") as { http: { get: typeof get } };
  const sensitiveHeaders = runInNewContext('["X-Synthetic-Secret"]') as string[];
  assert.equal(Array.isArray(sensitiveHeaders), true);
  // biome-ignore lint/suspicious/useIsArray: This regression proves the fixture belongs to another realm.
  assert.equal(sensitiveHeaders instanceof Array, false);
  let destinationHeaders: Record<string, unknown> | undefined;
  let initialHeader: string | string[] | undefined;
  let destinationPort = 0;
  const destination = createServer((request, response) => {
    destinationHeaders = request.headers;
    response.end("synthetic-ok");
  });
  const source = createServer((request, response) => {
    initialHeader = request.headers["x-synthetic-secret"];
    response.writeHead(302, { Location: `http://127.0.0.1:${destinationPort}/target` });
    response.end();
  });
  try {
    destinationPort = await listen(destination);
    const sourcePort = await listen(source);
    await new Promise<void>((resolve, reject) => {
      const options = {
        hostname: "127.0.0.1",
        port: sourcePort,
        path: "/",
        agent: false as const,
        sensitiveHeaders,
        headers: { "X-Synthetic-Secret": "synthetic-only" },
      };
      const request = follow.http.get(options, (response) => {
        response.resume();
        response.once("end", resolve);
        response.once("error", reject);
      });
      request.setTimeout(3000, () => request.destroy(new Error("synthetic redirect timed out")));
      request.once("error", reject);
    });
    expect(initialHeader).toBe("synthetic-only");
    expect(destinationHeaders).toBeDefined();
    expect(destinationHeaders?.["x-synthetic-secret"]).toBeUndefined();
  } finally {
    await Promise.all([close(source), close(destination)]);
  }
});
