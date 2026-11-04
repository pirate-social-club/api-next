// Build-tool source resolution only. No package export, runtime, mock or grant.
import { existsSync, readFileSync } from "node:fs";

const entries: [string, string][] = [];
for (const name of [
  "application",
  "platform-cf",
  "contracts",
  "domain",
  "verifier-response-contract",
]) {
  const directory = new URL(`../packages/${name}/`, import.meta.url);
  const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("exports" in manifest) ||
    typeof manifest.exports !== "object" ||
    manifest.exports === null ||
    Array.isArray(manifest.exports)
  )
    throw new Error(`Invalid workspace exports: ${name}`);
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (
      (subpath !== "." && !subpath.startsWith("./")) ||
      subpath.includes("*") ||
      typeof target !== "string" ||
      !target.startsWith("./") ||
      target.includes("*") ||
      target.split("/").includes("..")
    )
      throw new Error(`Unsupported workspace export: ${name}/${subpath}`);
    const resolved = new URL(target, directory).pathname;
    if (!existsSync(resolved))
      throw new Error(`Missing workspace export target: ${name}/${subpath}`);
    entries.push([`@pirate/${name}${subpath === "." ? "" : subpath.slice(1)}`, resolved]);
  }
}
// Exact longest subpaths precede package roots for BOTH Vite and Workerd.
export const workspacePublicAliases: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(entries.sort(([a], [b]) => b.length - a.length)),
);
/** Existing explicitly admitted private aliases retain precedence and targets. */
export function withWorkspacePublicAliases(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...workspacePublicAliases, ...overrides }).sort(
      ([a], [b]) => b.length - a.length,
    ),
  );
}
