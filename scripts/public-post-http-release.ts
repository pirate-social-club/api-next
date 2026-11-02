import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { superviseProductionTimeout } from "./production-release/production-bounded-process.ts";
import { checkBoundProcess } from "./production-release/production-linux-process-bound.ts";
import {
  assertReview,
  PublicPostReleaseRefused,
  publicPostHttpRelease,
  requireRelease,
} from "./public-post-http-release-core.ts";
import { realHttpReleaseIo } from "./public-post-http-release-provider.ts";
import {
  assertExecutionTools,
  assertToolingSource,
  fileHash,
  HTTP_PATHS,
  publicPostExecutionTools,
  readHttpReview,
} from "./public-post-http-release-source.ts";

type Mode = "snapshot" | "apply" | "verify" | "rollback";
interface Options {
  readonly mode: Mode;
  readonly child: boolean;
  readonly reviewPath?: string | undefined;
  readonly reviewSha?: string | undefined;
  readonly from?: string | undefined;
}
export function parseHttpReleaseArguments(argv: readonly string[]): Options {
  const args = [...argv],
    child = args[0] === "--child";
  if (child) args.shift();
  const mode = args.shift();
  requireRelease(
    mode === "snapshot" || mode === "apply" || mode === "verify" || mode === "rollback",
    "usage-snapshot-or-apply-verify-rollback-with-review-and-sha",
  );
  const values = new Map<string, string>();
  requireRelease(!child || mode === "apply" || mode === "rollback", "child-mode-is-mutation-only");
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    requireRelease(
      key &&
        ["--review", "--review-sha", "--from"].includes(key) &&
        value &&
        !value.startsWith("--") &&
        !values.has(key),
      "unknown-or-duplicate-release-argument",
    );
    values.set(key, value);
  }
  requireRelease(
    mode === "snapshot"
      ? !child && values.size === 0
      : values.has("--review") && values.has("--review-sha"),
    "review-required-or-snapshot-arguments-refused",
  );
  requireRelease(
    mode === "rollback"
      ? /^[a-f0-9-]{36}$/.test(values.get("--from") ?? "")
      : !values.has("--from"),
    "rollback-from-required-only-for-rollback",
  );
  return {
    mode,
    child,
    reviewPath: values.get("--review"),
    reviewSha: values.get("--review-sha"),
    from: values.get("--from"),
  };
}
async function main(argv: readonly string[]) {
  const options = parseHttpReleaseArguments(argv);
  if (options.mode === "snapshot") {
    const snapshot = await publicPostHttpRelease("snapshot", undefined, "", realHttpReleaseIo());
    return { ...snapshot, execution_tools: publicPostExecutionTools() };
  }
  requireRelease(options.reviewPath && options.reviewSha, "independent-review-required");
  const review = readHttpReview(options.reviewPath, options.reviewSha);
  assertReview(review, Date.now(), options.mode === "apply" || options.mode === "rollback");
  assertExecutionTools(review);
  assertToolingSource(review.tooling_source);
  const mutating = options.mode === "apply" || options.mode === "rollback";
  const self = realpathSync(resolve(HTTP_PATHS.tooling, "scripts/public-post-http-release.ts"));
  if (mutating && !options.child) {
    mkdirSync(HTTP_PATHS.evidence, { recursive: true, mode: 0o700 });
    const result = await superviseProductionTimeout({
      journalDirectory: HTTP_PATHS.evidence,
      wrapperPath: self,
      wrapperArguments: [...argv],
      argv: [process.execPath, self, "--child", ...argv],
      mode: options.mode,
      executorSha256: fileHash(self),
      admissionSha256: options.reviewSha,
      reviewSha256: options.reviewSha,
      executionTools: {
        bun_sha256: review.execution_tools.bun_sha256,
        timeout_sha256: review.execution_tools.timeout_sha256,
      },
    });
    return { bounded_command_complete: true, ...result };
  }
  requireRelease(!options.child || mutating, "child-mode-is-mutation-only");
  const assertBound = () => {
    requireRelease(options.child && mutating, "bounded-child-required");
    const path = process.env.PIRATE_RELEASE_OUTER_START_PATH;
    requireRelease(
      typeof path === "string" &&
        path.startsWith(`${HTTP_PATHS.evidence}/outer-`) &&
        path.endsWith("-start.json"),
      "owned-outer-start-required",
    );
    const start = JSON.parse(readFileSync(path, "utf8"));
    requireRelease(
      start.executor_sha256 === fileHash(self) &&
        start.wrapper_sha256 === fileHash(self) &&
        start.review_sha256 === options.reviewSha &&
        start.admission_sha256 === options.reviewSha &&
        start.mode === options.mode,
      "bound-operation-tuple-differs",
    );
    const childPath = path.replace(/-start\.json$/, "-child.json");
    const child = JSON.parse(readFileSync(childPath, "utf8"));
    requireRelease(child.start_sha256 === fileHash(path), "bound-child-start-differs");
    checkBoundProcess(start, child, self, review);
  };
  if (mutating) assertBound();
  return publicPostHttpRelease(
    options.mode,
    review,
    options.reviewSha,
    realHttpReleaseIo(review, assertBound),
    options.from,
  );
}
if (import.meta.main) {
  main(process.argv.slice(2))
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      const reason =
        error instanceof PublicPostReleaseRefused
          ? error.message
          : "HTTP operation refused or unresolved; preserve evidence and verify read-only";
      console.error(JSON.stringify({ success: false, reason }));
      process.exitCode = 1;
    });
}
