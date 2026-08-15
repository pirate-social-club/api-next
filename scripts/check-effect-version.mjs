#!/usr/bin/env node

// Keep the Effect dependency graph on one reviewed version. This checks the
// declarations, Bun's resolved lockfile entries, and every installed copy so
// an API mismatch cannot be papered over by changing a dependency version.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "4.0.0-rc.109";
const root = fileURLToPath(new URL("..", import.meta.url));
const rootManifestPath = join(root, "package.json");
const rootManifest = readJson(rootManifestPath);
const violations = [];
const effectPackages = new Set();
const rootEffectDependencies = new Set();

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`check:effect — unable to read ${path}: ${error.message}`);
    process.exit(1);
  }
}

function isEffectPackage(name) {
  return name === "effect" || name.startsWith("@effect/");
}

function addViolation(message) {
  violations.push(message);
}

function packageManifestPaths() {
  const paths = [rootManifestPath];
  for (const workspace of rootManifest.workspaces ?? []) {
    if (!workspace.endsWith("/*")) {
      const path = join(root, workspace, "package.json");
      if (existsSync(path)) paths.push(path);
      continue;
    }

    const directory = join(root, workspace.slice(0, -2));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name, "package.json");
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

function dependencyEntries(manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
    (section) =>
      Object.entries(manifest[section] ?? {}).map(([name, range]) => ({
        name,
        range,
        section,
      })),
  );
}

for (const path of packageManifestPaths()) {
  const manifest = readJson(path);
  for (const { name, range, section } of dependencyEntries(manifest)) {
    if (!isEffectPackage(name)) continue;
    effectPackages.add(name);
    if (path === rootManifestPath) rootEffectDependencies.add(name);
    if (range !== EXPECTED_VERSION) {
      addViolation(
        `${relative(root, path)} ${section}.${name} declares ${range}; expected ${EXPECTED_VERSION}`,
      );
    }
  }
}

const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
const lockEntryPattern = /^\s+"[^"]+":\s+\["([^"]+)"/gm;
const resolvedEffectPattern = /^(effect|@effect\/[^@]+)@(.+)$/;
let lockEntryCount = 0;

for (const match of lockfile.matchAll(lockEntryPattern)) {
  const [, resolved] = match;
  const resolution = resolved.match(resolvedEffectPattern);
  if (!resolution) continue;
  const [, name, version] = resolution;
  lockEntryCount += 1;
  effectPackages.add(name);
  if (version !== EXPECTED_VERSION) {
    addViolation(`bun.lock resolves ${name} to ${version}; expected ${EXPECTED_VERSION}`);
  }
}

if (lockEntryCount === 0) {
  addViolation("bun.lock contains no effect or @effect/* resolution");
}

function scanNodeModules(directory, installedPackages) {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);

    if (entry.name === ".bun") {
      scanBunStore(path, installedPackages);
    } else if (entry.name.startsWith("@") && !existsSync(join(path, "package.json"))) {
      scanScope(path, entry.name, installedPackages);
    } else {
      scanPackage(path, entry.name, installedPackages);
    }
  }
}

function scanBunStore(directory, installedPackages) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    scanPackage(join(directory, entry.name), undefined, installedPackages);
  }
}

function scanScope(directory, scope, installedPackages) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    scanPackage(join(directory, entry.name), `${scope}/${entry.name}`, installedPackages);
  }
}

function scanPackage(directory, name, installedPackages) {
  const manifestPath = join(directory, "package.json");
  if (name && existsSync(manifestPath) && isEffectPackage(name)) {
    const version = readJson(manifestPath).version;
    installedPackages.push({ name, path: manifestPath, version });
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") {
      scanNodeModules(path, installedPackages);
    } else if (entry.name === ".bun") {
      scanBunStore(path, installedPackages);
    }
  }
}

const installedPackages = [];
scanNodeModules(join(root, "node_modules"), installedPackages);

for (const installed of installedPackages) {
  effectPackages.add(installed.name);
  if (installed.version !== EXPECTED_VERSION) {
    addViolation(
      relative(root, installed.path) +
        " resolves " +
        installed.name +
        " to " +
        installed.version +
        "; expected " +
        EXPECTED_VERSION,
    );
  }
}

for (const name of rootEffectDependencies) {
  const installedPath = join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(installedPath)) {
    addViolation(`${name} is not installed at ${relative(root, installedPath)}`);
  }
}

if (violations.length > 0) {
  console.error(`check:effect — ${violations.length} version violation(s):`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`check:effect — Effect packages pinned to ${EXPECTED_VERSION}`);
