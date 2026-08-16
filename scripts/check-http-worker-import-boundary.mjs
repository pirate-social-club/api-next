import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve("apps/http-worker/src");
const violations = [];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) result.push(path);
  }
  return result;
}

for (const file of await files(root)) {
  const source = await Bun.file(file).text();
  const imports = source.matchAll(/(?:from\s+|import\s*\()?["']([^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === "@pirate/application" || specifier.startsWith("@pirate/application/")) {
      if (!specifier.startsWith("@pirate/application/use-cases/")) {
        violations.push(`${relative(".", file)} imports ${specifier}`);
      }
    }
    if (specifier.includes("/packages/application/src/") && !specifier.includes("/use-cases/")) {
      violations.push(`${relative(".", file)} imports application internals via ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error("http-worker import boundary violations:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exitCode = 1;
} else {
  console.log("http-worker import boundary clean");
}
