import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { superviseProductionTimeout } from "./production-release/production-bounded-process.ts";
import {
  checkBoundProcess,
  linuxProcess,
} from "./production-release/production-linux-process-bound.ts";
import { parseHttpReleaseArguments } from "./public-post-http-release.ts";
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
  publicPostExecutionTools,
  readHttpReview,
} from "./public-post-http-release-source.ts";
import { REWARDS_AVAILABILITY_HTTP as policy } from "./rewards-availability-http-release-policy.ts";

async function main(argv: readonly string[]) {
  const self = realpathSync(
    resolve(policy.paths.tooling, "scripts/rewards-availability-http-release.ts"),
  );
  const invoked = linuxProcess(process.pid).cmdline;
  requireRelease(
    invoked[0] === process.execPath && invoked[1] === self,
    "absolute-fixed-entry-required",
  );
  // Harmless qualification exercises this exact wrapper/timeout/child ancestry. It never
  // enters source/provider/database adapters and cannot select an operation or target.
  if (
    (argv.length === 1 && argv[0] === "process-check") ||
    (argv.length === 2 && argv[0] === "--child" && argv[1] === "process-check")
  ) {
    const evidence = resolve(policy.paths.evidence, "process-checks");
    const tools = publicPostExecutionTools();
    const hash = fileHash(self);
    if (argv[0] !== "--child") {
      mkdirSync(evidence, { recursive: true, mode: 0o700 });
      return superviseProductionTimeout({
        journalDirectory: evidence,
        wrapperPath: self,
        wrapperArguments: [...argv],
        argv: [process.execPath, self, "--child", "process-check"],
        mode: "process-check",
        executorSha256: hash,
        admissionSha256: hash,
        reviewSha256: hash,
        executionTools: tools,
      });
    }
    const startPath = process.env.PIRATE_RELEASE_OUTER_START_PATH;
    requireRelease(
      typeof startPath === "string" &&
        startPath.startsWith(`${evidence}/outer-`) &&
        startPath.endsWith("-start.json"),
      "owned-process-check-start-required",
    );
    const childPath = startPath.replace(/-start\.json$/, "-child.json");
    const until = Date.now() + 1000;
    while (!existsSync(childPath) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 5));
    checkFixedBound("process-check", hash, { execution_tools: tools }, self, evidence);
    return { process_check: true, provider_calls: 0, database_calls: 0 };
  }
  const options = parseHttpReleaseArguments(argv);
  if (options.mode === "snapshot") {
    const snapshot = await publicPostHttpRelease(
      "snapshot",
      undefined,
      "",
      realHttpReleaseIo(undefined, undefined, policy),
      undefined,
      policy,
    );
    return { ...snapshot, execution_tools: publicPostExecutionTools() };
  }
  requireRelease(options.reviewPath && options.reviewSha, "independent-review-required");
  const review = readHttpReview(options.reviewPath, options.reviewSha);
  assertReview(review, Date.now(), options.mode === "apply" || options.mode === "rollback", policy);
  assertExecutionTools(review);
  assertToolingSource(review.tooling_source, policy.paths);
  const mutating = options.mode === "apply" || options.mode === "rollback";
  if (mutating && !options.child) {
    mkdirSync(policy.paths.evidence, { recursive: true, mode: 0o700 });
    const result = await superviseProductionTimeout({
      journalDirectory: policy.paths.evidence,
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
    requireRelease(options.reviewSha, "independent-review-required");
    checkFixedBound(options.mode, options.reviewSha, review, self, policy.paths.evidence);
  };
  if (mutating) assertBound();
  return publicPostHttpRelease(
    options.mode,
    review,
    options.reviewSha,
    realHttpReleaseIo(review, assertBound, policy),
    options.from,
    policy,
  );
}
function checkFixedBound(
  mode: string,
  reviewSha: string,
  review: { readonly execution_tools: unknown },
  self: string,
  evidence: string,
) {
  const path = process.env.PIRATE_RELEASE_OUTER_START_PATH;
  requireRelease(
    typeof path === "string" &&
      path.startsWith(`${evidence}/outer-`) &&
      path.endsWith("-start.json"),
    "owned-outer-start-required",
  );
  const start = JSON.parse(readFileSync(path, "utf8"));
  requireRelease(
    start.executor_sha256 === fileHash(self) &&
      start.wrapper_sha256 === fileHash(self) &&
      start.review_sha256 === reviewSha &&
      start.admission_sha256 === reviewSha &&
      start.mode === mode,
    "bound-operation-tuple-differs",
  );
  const childPath = path.replace(/-start\.json$/, "-child.json");
  const child = JSON.parse(readFileSync(childPath, "utf8"));
  requireRelease(child.start_sha256 === fileHash(path), "bound-child-start-differs");
  checkBoundProcess(start, child, self, review);
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
