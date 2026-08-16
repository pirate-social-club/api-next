#!/usr/bin/env node
// Dependency-matrix lint (api-next 000 §4; 001 phase 0 step 1).
//
//   contracts, domain      -> no internal imports
//   application            -> contracts, domain
//   platform-cf, testing   -> application, contracts, domain
//   apps                   -> everything except testing
//   nothing                -> apps
//   domain: effect restricted to Schema + data types (no runtime modules)
//
// Exit 1 on any violation. Run from the repo root via `bun run lint:deps`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const INTERNAL = {
  "packages/contracts": "@pirate/contracts",
  "packages/api-client": "@pirate/api-client",
  "packages/domain": "@pirate/domain",
  "packages/application": "@pirate/application",
  "packages/platform-cf": "@pirate/platform-cf",
  "packages/testing": "@pirate/testing",
  "apps/http-worker": "@pirate/http-worker",
  "apps/jobs-worker": "@pirate/jobs-worker",
};

const ALLOWED = {
  "@pirate/contracts": [],
  "@pirate/api-client": ["@pirate/contracts"],
  "@pirate/domain": [],
  "@pirate/application": ["@pirate/contracts", "@pirate/domain"],
  "@pirate/platform-cf": ["@pirate/application", "@pirate/contracts", "@pirate/domain"],
  "@pirate/testing": ["@pirate/application", "@pirate/contracts", "@pirate/domain"],
  "@pirate/http-worker": [
    "@pirate/application",
    "@pirate/contracts",
    "@pirate/domain",
    "@pirate/platform-cf",
  ],
  "@pirate/jobs-worker": [
    "@pirate/application",
    "@pirate/contracts",
    "@pirate/domain",
    "@pirate/platform-cf",
  ],
};

// domain may import only these effect entry points (000 §4).
const DOMAIN_EFFECT_ALLOWLIST = new Set([
  "effect",
  "effect/Schema",
  "effect/Data",
  "effect/TypeError",
]);

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

function walkTs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTs(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

const violations = [];
const root = process.cwd();

for (const [dir, pkg] of Object.entries(INTERNAL)) {
  for (const file of walkTs(join(root, dir))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (!spec.startsWith("@pirate/")) continue;
      const rel = relative(root, file);
      if (spec === pkg) continue; // self-imports are intra-package
      if (spec === "@pirate/http-worker" || spec === "@pirate/jobs-worker") {
        violations.push(`${rel}: nothing imports apps (found ${spec})`);
        continue;
      }
      const allowed = ALLOWED[pkg].some(
        (dependency) => spec === dependency || spec.startsWith(`${dependency}/`),
      );
      if (!allowed) {
        violations.push(`${rel}: ${pkg} may not import ${spec}`);
      }
    }
    if (pkg === "@pirate/domain") {
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (spec.startsWith("effect") && !DOMAIN_EFFECT_ALLOWLIST.has(spec)) {
          violations.push(
            `${relative(root, file)}: domain may use only Schema/Data effect modules (found ${spec})`,
          );
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`lint:deps — ${violations.length} dependency-matrix violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("lint:deps — dependency matrix clean");
