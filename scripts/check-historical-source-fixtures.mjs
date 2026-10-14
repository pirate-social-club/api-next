// Immutable accepted API-next fixture APIs are intentional entries, not new runtime exports.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTypeScript } from "./check-deps.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const catalogPath = resolve(root, "scripts/historical-api-next-source-fixtures.json");
const bytes = readFileSync(catalogPath);
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "abc26b99d2031216858232630edc8394bfa78bd7e7204b659e1718fd22cdbc7a"
)
  throw new Error(
    "Reviewed historical fixture catalogue changed; independent source closure review required",
  );
const catalog = JSON.parse(bytes);
if (
  catalog.format !== "exact-immutable-same-api-historical-fixture-entry-catalog-v1" ||
  catalog.acceptedCommit !== "3ef1f879783b1eaa816bb21ecc0c5253e92375f8" ||
  catalog.prefix !== "packages/platform-cf/src/historical-api-next-3ef1f879.pg-fixture/" ||
  catalog.rawFiles.length !== 36
)
  throw new Error("Exact accepted36 historical source catalogue required");
const read = (path) => {
  const absolute = resolve(root, path);
  if (
    !absolute.startsWith(`${root}/`) ||
    lstatSync(absolute).isSymbolicLink() ||
    realpathSync(absolute) !== absolute
  )
    throw new Error(`Historical source path is not a regular local path: ${path}`);
  return readFileSync(absolute);
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const rawPaths = new Set(catalog.rawFiles.map((row) => row.path));
if (rawPaths.size !== 36) throw new Error("Historical source catalogue duplicates");
const authoredPaths = new Set(Object.keys(catalog.authoredFixtureFiles));
const allowedTargets = new Set([...rawPaths, ...authoredPaths]);
// The immutable namespace contains exactly raw36 plus authored3 regular files.
// Census all entry kinds before source scanning: JSON/TXT, directories and symlinks fail.
const census = readdirSync(resolve(root, catalog.prefix), { withFileTypes: true });
if (
  allowedTargets.size !== 39 ||
  census.length !== 39 ||
  census.some((entry) => !entry.isFile() || !allowedTargets.has(`${catalog.prefix}${entry.name}`))
)
  throw new Error("Immutable historical namespace must contain exactly39 declared regular files");
const callers = new Set(Object.keys(catalog.approvedTestCallers));
for (const caller of callers)
  if (!caller.endsWith(".pg.test.ts") && !caller.endsWith(".pg-fixture.ts"))
    throw new Error("Historical source caller must be an explicit test fixture");
for (const row of catalog.rawFiles) {
  if (
    !row.path.startsWith(catalog.prefix) ||
    row.acceptedPath !== `packages/platform-cf/src/${row.path.slice(catalog.prefix.length)}`
  )
    throw new Error("Historical source layout differs from accepted API source");
  const value = read(row.path);
  const gitBlob = createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
  if (hash(value) !== row.sha256 || gitBlob !== row.gitBlob)
    throw new Error(`Accepted historical source blob changed: ${row.path}`);
  const local = [
    ...new Set(
      analyzeTypeScript(value.toString(), row.path)
        .imports.map((item) => item.spec)
        .filter((spec) => spec.startsWith(".")),
    ),
  ].sort();
  if (JSON.stringify(local) !== JSON.stringify(row.relativeDependencies))
    throw new Error(`Historical source dependency graph changed: ${row.path}`);
  for (const spec of local) {
    const target = relative(root, resolve(root, dirname(row.path), spec)).replaceAll("\\", "/");
    if (!rawPaths.has(target))
      throw new Error(`Historical source edge escapes exact36: ${row.path}`);
  }
}
for (const records of [
  catalog.authoredFixtureFiles,
  catalog.approvedTestCallers,
  catalog.externalApiOrigins,
])
  for (const [path, expected] of Object.entries(records))
    if (hash(read(path)) !== expected)
      throw new Error(`Reviewed historical source boundary changed: ${path}`);
if (JSON.parse(read("package.json")).dependencies.effect !== catalog.effectVersion)
  throw new Error("Historical fixture Effect source compatibility requires renewed review");
const knip = JSON.parse(read("knip.json"));
const expectedEntries = [
  "src/index.ts",
  ...catalog.rawFiles.map((row) => row.path.slice("packages/platform-cf/".length)),
];
if (
  JSON.stringify(knip.workspaces["packages/platform-cf"]?.entry) !== JSON.stringify(expectedEntries)
)
  throw new Error(
    "Historical immutable entries must be exact36, never a wildcard or hygiene exemption",
  );
const files = [];
const walk = (directory) => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".wrangler", "dist", "generated"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) files.push(path);
  }
};
for (const directory of ["packages", "apps", "scripts", "tests", "infra"])
  walk(resolve(root, directory));
for (const file of files) {
  const sourcePath = relative(root, file).replaceAll("\\", "/");
  if (sourcePath.startsWith(catalog.prefix) && !allowedTargets.has(sourcePath))
    throw new Error(`Unreviewed file in immutable historical source tree: ${sourcePath}`);
  for (const { spec } of analyzeTypeScript(readFileSync(file, "utf8"), sourcePath).imports) {
    const target = spec.startsWith(".")
      ? relative(root, resolve(dirname(file), spec)).replaceAll("\\", "/")
      : spec;
    if (
      target.startsWith(catalog.prefix) ||
      spec.includes("historical-api-next-3ef1f879.pg-fixture")
    ) {
      if (
        (!allowedTargets.has(sourcePath) && !callers.has(sourcePath)) ||
        !allowedTargets.has(target)
      )
        throw new Error(`Production or unreviewed incoming historical source edge: ${sourcePath}`);
    }
  }
}
console.log(
  "historical-source-fixtures: exact36 accepted blobs, closed graph, bound external APIs and explicit test-only callers; intentional fixture entry APIs retained",
);
