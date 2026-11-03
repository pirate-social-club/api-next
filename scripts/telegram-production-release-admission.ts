import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  directoryIdentity,
  exclusiveRecord,
} from "./production-release/production-operation-evidence.ts";
import { checkBackup } from "./production-release/production-release-admission.ts";
import { sha256 } from "./public-post-http-release-core.ts";
import type { publicPostExecutionTools } from "./public-post-http-release-source.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
  TELEGRAM_PHASES,
  type TelegramAction,
  type TelegramPhase,
} from "./telegram-production-release-policy.ts";

export interface TelegramFile {
  readonly path: string;
  readonly sha256: string;
}
export interface TelegramReview {
  readonly kind: "telegram-production-practice-review-v1";
  readonly operation: typeof policy.operation;
  readonly accepted: true;
  readonly reviewer_role: "independent_reviewer";
  readonly findings: readonly never[];
  readonly tooling_source: string;
  readonly execution_tools: ReturnType<typeof publicPostExecutionTools>;
  readonly tooling_dependencies: TelegramFile;
  readonly authority: TelegramFile;
  readonly files: readonly TelegramFile[];
  readonly evidence_identity: ReturnType<typeof directoryIdentity>;
  readonly journal_identity: ReturnType<typeof directoryIdentity>;
  readonly production_backup: TelegramFile;
  readonly website_receipt: TelegramFile;
  readonly credential_contract: TelegramFile;
  readonly catalogue_acceptance: TelegramFile;
  readonly channel_readiness?: TelegramFile;
  readonly configs: Readonly<Partial<Record<TelegramPhase, TelegramFile>>>;
  readonly recovery_targets: Readonly<Record<"http" | "jobs", TelegramFile>>;
  readonly accepted_predecessor_reviews: readonly string[];
  readonly resolutions: Readonly<
    Partial<
      Record<
        TelegramPhase,
        {
          readonly accepted: true;
          readonly reviewer_role: "independent_reviewer";
          readonly attempt_sha256: string;
          readonly observation_sha256: string;
          readonly conclusion: "effect_verified" | "not_applied";
        }
      >
    >
  >;
  /** Exact pre-effect safe observations, independently reviewed for each phase. */
  readonly before: Readonly<Partial<Record<TelegramPhase, string>>>;
  readonly after: Readonly<Partial<Record<TelegramPhase, string>>>;
}
export interface TelegramAdmission {
  readonly kind: "telegram-production-resource-admission-v1";
  readonly operation: typeof policy.operation;
  readonly review_sha256: string;
  readonly phase: TelegramPhase;
  readonly access: "observe" | "effect";
  readonly resource_owner_role: "workspace_coordinator";
  readonly exclusive: true;
  readonly resources: readonly string[];
  readonly not_before: string;
  readonly latest_start: string;
  readonly expires_at: string;
  readonly recovery_until: string;
}
interface Authority {
  readonly kind: "telegram-production-owner-authority-v1";
  readonly actor_role: "workspace_owner";
  readonly accepted: true;
  readonly task: typeof policy.task;
  readonly operation: typeof policy.operation;
  readonly instruction: TelegramFile;
  readonly actions: readonly TelegramAction[];
  readonly community: typeof policy.canary.community;
  readonly post: typeof policy.canary.post;
  readonly funds: false;
}
export function telegramFile(file: TelegramFile) {
  requireTelegram(
    isAbsolute(file.path) && /^[a-f0-9]{64}$/u.test(file.sha256),
    "reviewed-file-required",
  );
  const stat = lstatSync(file.path);
  requireTelegram(stat.isFile() && !stat.isSymbolicLink(), "reviewed-file-not-regular");
  const bytes = readFileSync(file.path);
  requireTelegram(sha256(bytes) === file.sha256, "reviewed-file-changed");
  return bytes;
}
export function telegramJson<T>(file: TelegramFile): T {
  return JSON.parse(telegramFile(file).toString("utf8")) as T;
}
const time = (value: string) => {
  const result = Date.parse(value);
  requireTelegram(Number.isFinite(result), "invalid-resource-window");
  return result;
};
/** Scope authority persists; finite execution windows are a separate technical requirement. */
export function admitTelegram(
  review: TelegramReview,
  reviewSha: string,
  admission: TelegramAdmission,
  phase: TelegramPhase,
  access: TelegramAdmission["access"],
  now: number,
  evidenceDirectory: string = policy.paths.operation,
) {
  requireTelegram(
    review.kind === "telegram-production-practice-review-v1" &&
      review.operation === policy.operation &&
      review.accepted === true &&
      review.reviewer_role === "independent_reviewer" &&
      Array.isArray(review.findings) &&
      review.findings.length === 0 &&
      /^[a-f0-9]{40}$/u.test(review.tooling_source),
    "exact-operation-review-required",
  );
  const authority = telegramJson<Authority>(review.authority);
  telegramFile(authority.instruction);
  requireTelegram(
    authority.kind === "telegram-production-owner-authority-v1" &&
      authority.actor_role === "workspace_owner" &&
      authority.accepted === true &&
      authority.task === policy.task &&
      authority.operation === policy.operation &&
      authority.community === policy.canary.community &&
      authority.post === policy.canary.post &&
      authority.funds === false &&
      authority.actions.includes(TELEGRAM_PHASES[phase].action),
    "task-specific-owner-authority-required",
  );
  requireTelegram(
    admission.kind === "telegram-production-resource-admission-v1" &&
      admission.operation === policy.operation &&
      admission.review_sha256 === reviewSha &&
      admission.phase === phase &&
      admission.access === access &&
      admission.resource_owner_role === "workspace_coordinator" &&
      admission.exclusive === true &&
      isDeepStrictEqual(admission.resources, policy.resources),
    "exact-exclusive-resource-admission-required",
  );
  const begin = time(admission.not_before),
    latest = time(admission.latest_start),
    end = time(admission.expires_at),
    recovery = time(admission.recovery_until);
  requireTelegram(
    begin <= now &&
      now <= latest &&
      latest <= end &&
      end - now >= 200_000 &&
      end - begin <= 900_000 &&
      recovery >= end + 200_000 &&
      recovery - begin <= 3_600_000,
    "resource-window-not-current-or-insufficient",
  );
  requireTelegram(
    isDeepStrictEqual(directoryIdentity(evidenceDirectory), review.evidence_identity),
    "evidence-directory-identity-changed",
  );
  for (const file of review.files) telegramFile(file);
  telegramFile(review.website_receipt);
  telegramFile(review.credential_contract);
  if (["migration", "grants", "catalogue", "pause-http"].includes(phase)) checkBackup(review, now);
  return authority;
}

export interface TelegramReceipt {
  readonly kind: "telegram-production-phase-v1";
  readonly operation: typeof policy.operation;
  readonly phase: TelegramPhase;
  readonly state: "attempt" | "verified";
  readonly at: string;
  readonly review_sha256: string;
  readonly admission_sha256: string;
  readonly before_sha256: string;
  readonly attempt_sha256?: string;
  readonly after_sha256?: string;
}
export interface TelegramPhaseIo {
  now(): number;
  admit(access: TelegramAdmission["access"]): Promise<void>;
  read(phase: TelegramPhase, state: "attempt" | "verified"): TelegramReceipt | undefined;
  save(receipt: TelegramReceipt): string;
  attemptDigest(phase: TelegramPhase): string;
  resolution(phase: TelegramPhase, value: unknown): void;
  observe(): Promise<unknown>;
  /** Adapter must recheck the owned process and exact preconditions immediately before each effect. */
  effect(): Promise<void>;
}
/** No retry path exists. A lost acknowledgement leaves its immutable attempt unresolved. */
export async function telegramPhase(
  phase: TelegramPhase,
  review: TelegramReview,
  reviewSha: string,
  admissionSha: string,
  access: TelegramAdmission["access"],
  io: TelegramPhaseIo,
) {
  await io.admit(access);
  const observed = sha256(JSON.stringify(await io.observe()));
  if (access === "observe") return { phase, observation_sha256: observed };
  requireTelegram(
    !io.read(phase, "attempt") && !io.read(phase, "verified"),
    "phase-already-attempted-reconcile-read-only",
  );
  for (const previous of TELEGRAM_PHASES[phase].predecessors) {
    const receipt = io.read(previous, "verified");
    requireTelegram(
      receipt?.kind === "telegram-production-phase-v1" &&
        receipt.operation === policy.operation &&
        receipt.phase === previous &&
        receipt.state === "verified" &&
        [reviewSha, ...review.accepted_predecessor_reviews].includes(receipt.review_sha256) &&
        /^[a-f0-9]{64}$/u.test(receipt.after_sha256 ?? ""),
      "verified-predecessor-required",
    );
  }
  requireTelegram(
    review.before[phase] === observed && /^[a-f0-9]{64}$/u.test(review.after[phase] ?? ""),
    "unreviewed-phase-state",
  );
  const attempt = io.save({
    kind: "telegram-production-phase-v1",
    operation: policy.operation,
    phase,
    state: "attempt",
    at: new Date(io.now()).toISOString(),
    review_sha256: reviewSha,
    admission_sha256: admissionSha,
    before_sha256: observed,
  });
  // Re-admission after durable write catches windows which elapsed during preflight.
  await io.admit(access);
  requireTelegram(
    sha256(JSON.stringify(await io.observe())) === observed,
    "phase-state-moved-before-effect",
  );
  await io.effect();
  await io.admit(access);
  const after = sha256(JSON.stringify(await io.observe()));
  requireTelegram(review.after[phase] === after, "effect-unverified-preserve-attempt");
  io.save({
    kind: "telegram-production-phase-v1",
    operation: policy.operation,
    phase,
    state: "verified",
    at: new Date(io.now()).toISOString(),
    review_sha256: reviewSha,
    admission_sha256: admissionSha,
    before_sha256: observed,
    attempt_sha256: attempt,
    after_sha256: after,
  });
  return { phase, verified: true, after_sha256: after };
}
/** An independently reviewed observation can finish evidence; it never repeats the effect. */
export async function resolveTelegramPhase(
  phase: TelegramPhase,
  review: TelegramReview,
  reviewSha: string,
  admissionSha: string,
  io: TelegramPhaseIo,
) {
  await io.admit("observe");
  const attempt = io.read(phase, "attempt"),
    approved = review.resolutions[phase];
  requireTelegram(
    attempt?.operation === policy.operation &&
      attempt.phase === phase &&
      attempt.state === "attempt" &&
      !io.read(phase, "verified") &&
      approved?.accepted === true &&
      approved.reviewer_role === "independent_reviewer" &&
      approved.attempt_sha256 === io.attemptDigest(phase),
    "exact-attempt-resolution-review-required",
  );
  const observed = sha256(JSON.stringify(await io.observe()));
  requireTelegram(
    observed === approved.observation_sha256 &&
      observed ===
        (approved.conclusion === "effect_verified" ? review.after[phase] : review.before[phase]),
    "resolution-observation-not-the-reviewed-state",
  );
  await io.admit("observe");
  io.resolution(phase, {
    ...attempt,
    operation: policy.operation,
    phase,
    state: approved.conclusion === "effect_verified" ? "verified" : "not_applied",
    review_sha256: reviewSha,
    admission_sha256: admissionSha,
    at: new Date(io.now()).toISOString(),
    attempt_sha256: approved.attempt_sha256,
    observation_sha256: observed,
    conclusion: approved.conclusion,
    ...(approved.conclusion === "effect_verified" ? { after_sha256: observed } : {}),
  });
  return { phase, conclusion: approved.conclusion, effect_repeated: false };
}
export function telegramJournal(directory: string = policy.paths.operation) {
  return {
    attemptDigest: (phase: TelegramPhase) =>
      sha256(readFileSync(resolve(directory, `${phase}-attempt.json`))),
    resolution: (phase: TelegramPhase, value: unknown) =>
      exclusiveRecord(directory, `${phase}-resolution.json`, value),
    read(phase: TelegramPhase, state: "attempt" | "verified") {
      let path = resolve(directory, `${phase}-${state}.json`);
      if (!existsSync(path) && state === "verified")
        path = resolve(directory, `${phase}-resolution.json`);
      if (!existsSync(path)) return undefined;
      requireTelegram(
        lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
        "invalid-phase-receipt",
      );
      const receipt = JSON.parse(readFileSync(path, "utf8")) as TelegramReceipt;
      return receipt.state === state ? receipt : undefined;
    },
    save(receipt: TelegramReceipt) {
      const name = `${receipt.phase}-${receipt.state}.json`;
      exclusiveRecord(directory, name, receipt);
      return sha256(readFileSync(resolve(directory, name)));
    },
  };
}
