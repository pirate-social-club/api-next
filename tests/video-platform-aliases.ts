import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const pgProtocol = require.resolve("pg-protocol", { paths: [require.resolve("pg")] });
const pgCloudflare = `${dirname(require.resolve("pg-cloudflare/package.json", { paths: [require.resolve("pg")] }))}/dist/index.js`;
const root = new URL("../", import.meta.url).pathname;
// Match source subpaths before package roots, preserving each package's existing exports.
const exact = [
  "application",
  "platform-cf",
  "domain",
  "contracts",
  "verifier-response-contract",
].flatMap((name) => {
  const manifest = JSON.parse(readFileSync(`${root}packages/${name}/package.json`, "utf8")) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports).map(([key, value]) => ({
    find: `@pirate/${name}${key === "." ? "" : key.slice(1)}`,
    replacement: `${root}packages/${name}/${value.slice(2)}`,
  }));
});
export const videoPlatformAliases = [
  { find: "pg-protocol", replacement: pgProtocol },
  { find: "pg-cloudflare", replacement: pgCloudflare },
  ...exact
    .filter(({ find }) => find.split("/").length > 2)
    .sort((a, b) => b.find.length - a.find.length),
  { find: /^@pirate\/application\/(.+)$/u, replacement: `${root}packages/application/src/$1.ts` },
  { find: /^@pirate\/platform-cf\/(.+)$/u, replacement: `${root}packages/platform-cf/src/$1.ts` },
  { find: /^@pirate\/domain\/(.+)$/u, replacement: `${root}packages/domain/src/$1.ts` },
  ...["application", "platform-cf", "domain", "contracts", "verifier-response-contract"].map(
    (name) => ({ find: `@pirate/${name}`, replacement: `${root}packages/${name}/src/index.ts` }),
  ),
];

export const videoPostgresAliases = { "pg-protocol": pgProtocol, "pg-cloudflare": pgCloudflare };
