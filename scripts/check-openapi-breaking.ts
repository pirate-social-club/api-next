import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { diffBreaking, type OpenApiDocument } from "@pirate/contracts";

export type BaselineEvent = "pull_request" | "push";

export interface BaselineSelectionInput {
  readonly eventName: BaselineEvent;
  readonly pullRequestBaseSha?: string;
  readonly pushBaseSha?: string;
}

export function selectBaselineSha(input: BaselineSelectionInput): string {
  const sha = input.eventName === "pull_request" ? input.pullRequestBaseSha : input.pushBaseSha;
  if (sha === undefined || sha.trim() === "") {
    throw new Error(`Missing baseline SHA for ${input.eventName} event`);
  }
  return sha;
}

interface Deprecations {
  readonly deprecatedOperations: readonly {
    readonly operationId: string;
    readonly reason: string;
  }[];
}

function readBaselineDocument(baseSha: string, documentPath: string): string | undefined {
  if (baseSha.trim() === "" || baseSha.startsWith("-")) {
    throw new Error(`Invalid baseline SHA: ${JSON.stringify(baseSha)}`);
  }

  let resolvedSha: string;
  try {
    resolvedSha = execFileSync("git", ["rev-parse", "--verify", `${baseSha}^{commit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Unable to resolve baseline commit ${JSON.stringify(baseSha)}`, {
      cause: error,
    });
  }

  const show = spawnSync("git", ["show", `${resolvedSha}:${documentPath}`], {
    encoding: "utf8",
  });
  if (show.status === 0) return show.stdout;

  const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", resolvedSha, "--", documentPath], {
    encoding: "utf8",
  });
  if (tree.status !== 0) {
    throw new Error(`Unable to inspect baseline tree ${resolvedSha}: ${tree.stderr.trim()}`);
  }
  if (tree.stdout.trim() === "") return undefined;

  throw new Error(`Unable to read ${documentPath} from baseline commit ${resolvedSha}`);
}

// Diff the generated OpenAPI document against an explicitly supplied
// baseline. A valid baseline commit without the document is the only
// bootstrap case; all other baseline failures are fatal.
const path = "apps/http-worker/src/generated/openapi.json";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--base-sha" || args[1] === undefined) {
    throw new Error("Usage: bun scripts/check-openapi-breaking.ts --base-sha <commit>");
  }
  const baseSha = args[1];
  const oldText = readBaselineDocument(baseSha, path);
  if (oldText === undefined) {
    console.log(`No ${path} existed at baseline ${baseSha}; treating as bootstrap.`);
    return;
  }

  const oldDoc = JSON.parse(oldText) as OpenApiDocument;
  const newDoc = JSON.parse(
    await readFile(process.env.OPENAPI_DOCUMENT_PATH ?? path, "utf8"),
  ) as OpenApiDocument;
  const deprecations = JSON.parse(
    await readFile(
      process.env.OPENAPI_DEPRECATIONS_PATH ??
        new URL("../packages/contracts/deprecations.json", import.meta.url),
      "utf8",
    ),
  ) as Deprecations;
  const declared = new Set(deprecations.deprecatedOperations.map((entry) => entry.operationId));

  // Map "METHOD /path" of removed operations back to their old operation ids
  // so a declared deprecation can retire exactly one entry.
  const operationIds = new Map<string, string>();
  for (const [route, methods] of Object.entries(oldDoc.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = (operation as Record<string, unknown>).operationId;
      if (typeof id === "string") operationIds.set(`${method.toUpperCase()} ${route}`, id);
    }
  }

  const operationKey = (violation: string): string | undefined => {
    const match = violation.match(
      /^(?:operation removed: |operation id changed on |request |response status removed on |response )([A-Z]+ \/[^:]+)(?::|$)/,
    );
    return match?.[1];
  };

  // A coordinator-recorded deprecation is an explicit contract transition:
  // every break for that retired operation is reviewed as one unit. All
  // operations without a matching entry remain fully gate-protected.
  const breaks = diffBreaking(oldDoc, newDoc).filter((violation) => {
    const key = operationKey(violation);
    return key === undefined || !declared.has(operationIds.get(key) ?? "");
  });
  if (breaks.length > 0) {
    console.error(
      "Breaking OpenAPI changes detected (000 §5: append-only within a major version):",
    );
    for (const violation of breaks) console.error(`  - ${violation}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
