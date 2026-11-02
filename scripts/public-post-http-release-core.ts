import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type Binding, digest } from "./worker-binding-drift.ts";

export const HTTP_RELEASE = {
  source: "b0b88a075fbe24b59bb69650a39bb3cff563e514",
  tree: "9b08807f9dab2d79242b9e0fdfa9fbc604ad6125",
  base: "6862fa976a2fc387ee0e0274ba9f1b2abc447427",
  accepted: "0222c5310db1c4438e0d9980840c20d8b662114d",
  baseline: "0ca64fda-2415-4629-b6fe-68058eeea402",
  worker: "pirate-http-worker-production",
  config: "apps/http-worker/wrangler.jsonc",
  module: "d2e5c4f08c7a4e9787868374cb46d204003172ba2b8780dcbc6a7780a9f57592",
  packet: "6cb7154d6f652df0e75edcd4f44c304730043c9045ecf23ef5c443d3fff9df5c",
  bindings: "1ff7f08d6b915897a5543cd8017f7f16765a5783b76f406a66951c7b35c8ca75",
  settings: "db3c16b5f507d2662b64cb710d4049eade59535be1f15cc6b1ed74d947c6209b",
} as const;

export class PublicPostReleaseRefused extends Error {}
export function requireRelease(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new PublicPostReleaseRefused(reason);
}
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Only the observed default production representation of this fixed service is equivalent. */
export function normalizedVerifier(row: Binding): Binding {
  if (row.name !== "HNS_OWNER_VERIFIER") return row;
  requireRelease(
    row.type === "service" && row.service === "pirate-hns-owner-verifier-production",
    "verifier-service-changed",
  );
  requireRelease(
    row.environment === undefined || row.environment === "production",
    "verifier-environment-changed",
  );
  return { ...row, environment: "production" };
}

export interface HttpSnapshot {
  readonly version: string;
  readonly message: string;
  readonly deployment: string;
  readonly latest: string;
  readonly binding_runtime_sha256: string;
  readonly settings_sha256: string;
  readonly declared_comparable_sha256: string;
  readonly actual_comparable_sha256: string;
  readonly verifier_representations: { readonly actual: Binding; readonly declared: Binding };
  readonly namespaces: readonly Binding[];
  readonly domains: readonly Record<string, unknown>[];
  readonly subdomain: unknown;
}
export interface HttpReview {
  readonly kind: "public-post-http-operation-review-v1";
  readonly verdict: "accepted";
  readonly reviewer_role: "independent_coordinator_reviewer";
  readonly tooling_source: string;
  readonly snapshot_sha256: string;
  readonly source: string;
  readonly module_sha256: string;
  readonly packet_sha256: string;
  readonly baseline: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly attempt_sha256?: string;
  readonly execution_tools: {
    readonly bun_path: string;
    readonly bun_sha256: string;
    readonly timeout_sha256: string;
    readonly node_path: string;
    readonly node_sha256: string;
    readonly wrangler_cli_sha256: string;
  };
}
export interface HttpCandidate {
  readonly source: string;
  readonly tree: string;
  readonly module_sha256: string;
  readonly tooling_source: string;
}
export interface HttpAttempt {
  readonly source: string;
  readonly module_sha256: string;
  readonly review_sha256: string;
  readonly before: HttpSnapshot;
  readonly candidate: HttpCandidate;
}
export type UploadResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export interface HttpReleaseIo {
  readonly now: () => number;
  readonly candidate: () => Promise<HttpCandidate>;
  readonly collect: () => Promise<HttpSnapshot>;
  readonly read: (name: string) => unknown;
  readonly record: (name: string, value: unknown) => void;
  readonly guardedUpload: (
    commit: (send: () => Promise<UploadResult>) => Promise<UploadResult>,
  ) => Promise<void>;
  readonly modules: (version: string) => Promise<void>;
  readonly rollback: (version: string) => Promise<UploadResult>;
}

function configuration(snapshot: HttpSnapshot) {
  return {
    bindings: snapshot.binding_runtime_sha256,
    settings: snapshot.settings_sha256,
    namespaces: snapshot.namespaces,
    domains: snapshot.domains,
    subdomain: snapshot.subdomain,
  };
}
export function assertBaseline(snapshot: HttpSnapshot) {
  requireRelease(
    snapshot.version === HTTP_RELEASE.baseline && snapshot.message === `git:${HTTP_RELEASE.base}`,
    "baseline-version-or-source-changed",
  );
  requireRelease(snapshot.latest === snapshot.version, "unserved-upload-exists");
  requireRelease(
    snapshot.binding_runtime_sha256 === HTTP_RELEASE.bindings,
    "baseline-binding-or-runtime-drift",
  );
  requireRelease(snapshot.settings_sha256 === HTTP_RELEASE.settings, "baseline-settings-drift");
  requireRelease(
    snapshot.declared_comparable_sha256 === snapshot.actual_comparable_sha256,
    "candidate-configuration-differs",
  );
}
export function assertReview(review: HttpReview, now: number, mutating: boolean) {
  requireRelease(
    review.kind === "public-post-http-operation-review-v1" &&
      review.verdict === "accepted" &&
      review.reviewer_role === "independent_coordinator_reviewer",
    "independent-review-required",
  );
  requireRelease(
    review.source === HTTP_RELEASE.source &&
      review.module_sha256 === HTTP_RELEASE.module &&
      review.packet_sha256 === HTTP_RELEASE.packet &&
      review.baseline === HTTP_RELEASE.baseline,
    "review-tuple-differs",
  );
  requireRelease(/^[a-f0-9]{40}$/.test(review.tooling_source), "invalid-tooling-source");
  if (mutating) {
    const start = Date.parse(review.window_start),
      end = Date.parse(review.window_end);
    requireRelease(
      Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= now &&
        end - now >= 190_000 &&
        end - start <= 3_600_000,
      "review-window-not-ready",
    );
  }
}
function attempt(io: HttpReleaseIo): HttpAttempt {
  const value = io.read("upload-attempt.json") as HttpAttempt | undefined;
  requireRelease(
    value &&
      value.source === HTTP_RELEASE.source &&
      value.module_sha256 === HTTP_RELEASE.module &&
      value.candidate.source === HTTP_RELEASE.source &&
      value.candidate.tree === HTTP_RELEASE.tree,
    "valid-upload-attempt-required",
  );
  assertBaseline(value.before);
  return value;
}
function redact(result: UploadResult) {
  return {
    exit_code: result.exitCode,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr),
  };
}
async function verify(io: HttpReleaseIo, before: HttpSnapshot) {
  const after = await io.collect();
  requireRelease(
    after.version !== before.version &&
      after.message === `git:${HTTP_RELEASE.source}` &&
      after.latest === after.version,
    "candidate-not-serving",
  );
  requireRelease(
    isDeepStrictEqual(configuration(after), configuration(before)),
    "serving-configuration-changed",
  );
  await io.modules(after.version);
  requireRelease(isDeepStrictEqual(await io.collect(), after), "serving-version-moved");
  return after;
}

/** One fixed HTTP operation. Provider/DB adapters are never selected through CLI or environment. */
export async function publicPostHttpRelease(
  mode: "snapshot" | "apply" | "verify" | "rollback",
  review: HttpReview | undefined,
  reviewSha256: string,
  io: HttpReleaseIo,
  from?: string,
) {
  const candidate = await io.candidate();
  requireRelease(
    candidate.source === HTTP_RELEASE.source &&
      candidate.tree === HTTP_RELEASE.tree &&
      candidate.module_sha256 === HTTP_RELEASE.module,
    "candidate-differs",
  );
  if (mode === "snapshot") {
    const before = await io.collect();
    assertBaseline(before);
    return { read_only: true, candidate, snapshot: before, snapshot_sha256: digest(before) };
  }
  requireRelease(review, "independent-review-required");
  assertReview(review, io.now(), mode === "apply" || mode === "rollback");
  requireRelease(candidate.tooling_source === review.tooling_source, "tooling-source-differs");
  if (mode === "verify") {
    const started = attempt(io),
      current = await io.collect();
    if (current.version === started.before.version) {
      assertBaseline(current);
      requireRelease(
        isDeepStrictEqual(configuration(current), configuration(started.before)),
        "baseline-configuration-changed",
      );
      return { read_only: true, state: "baseline", version: current.version };
    }
    const after = await verify(io, started.before);
    io.record(`verify-${io.now()}.json`, {
      source: candidate.source,
      version: after.version,
      attempt_sha256: digest(started),
      review_sha256: reviewSha256,
    });
    return { read_only: true, state: "candidate", version: after.version, modules: 1 };
  }
  if (mode === "rollback") {
    const started = attempt(io);
    requireRelease(
      started.review_sha256 === reviewSha256 || review.attempt_sha256 === digest(started),
      "rollback-review-does-not-bind-attempt",
    );
    const current = await verify(io, started.before);
    requireRelease(current.version === from, "rollback-from-version-differs");
    io.record("rollback-attempt.json", {
      at: new Date(io.now()).toISOString(),
      from,
      to: HTTP_RELEASE.baseline,
      attempt_sha256: digest(started),
      review_sha256: reviewSha256,
    });
    const result = await io.rollback(HTTP_RELEASE.baseline);
    io.record("rollback-command-result.json", redact(result));
    requireRelease(result.exitCode === 0, "rollback-unresolved-use-read-only-verify");
    const restored = await io.collect();
    assertBaseline(restored);
    requireRelease(
      isDeepStrictEqual(configuration(restored), configuration(started.before)),
      "rollback-configuration-differs",
    );
    io.record("rollback-readback.json", restored);
    return { rolled_back: true, version: restored.version };
  }
  requireRelease(!io.read("upload-attempt.json"), "upload-attempt-spent-use-read-only-verify");
  const before = await io.collect();
  assertBaseline(before);
  requireRelease(digest(before) === review.snapshot_sha256, "reviewed-snapshot-differs");
  await io.guardedUpload(async (send) => {
    assertReview(review, io.now(), true);
    requireRelease(
      isDeepStrictEqual(await io.candidate(), candidate),
      "candidate-moved-before-upload",
    );
    requireRelease(isDeepStrictEqual(await io.collect(), before), "baseline-moved-before-upload");
    io.record("upload-attempt.json", {
      at: new Date(io.now()).toISOString(),
      source: HTTP_RELEASE.source,
      module_sha256: HTTP_RELEASE.module,
      review_sha256: reviewSha256,
      candidate,
      before,
    });
    let result: UploadResult;
    try {
      result = await send();
    } catch {
      io.record("upload-command-error.json", { unresolved: true });
      throw new PublicPostReleaseRefused("upload-unresolved-use-read-only-verify");
    }
    io.record("upload-command-result.json", redact(result));
    requireRelease(result.exitCode === 0, "upload-unresolved-use-read-only-verify");
    return result;
  });
  const after = await verify(io, before);
  requireRelease(
    isDeepStrictEqual(await io.candidate(), candidate),
    "candidate-moved-after-upload",
  );
  io.record("upload-readback.json", {
    at: new Date(io.now()).toISOString(),
    source: candidate.source,
    version: after.version,
    deployment: after.deployment,
    module_sha256: HTTP_RELEASE.module,
    rollback_target: before.version,
  });
  return { uploaded: true, version: after.version, modules: 1, rollback_target: before.version };
}
