import { recordKaraokeCleanupPass } from "./staging-karaoke-cleanup-pass.ts";
import {
  type KaraokeCollectorInput,
  loadKaraokeCollectorConfiguration,
} from "./staging-karaoke-collector-config.ts";
import { recordKaraokeObservationPass } from "./staging-karaoke-observation-pass.ts";
import { makeStagingKaraokeR2Cleaner } from "./staging-karaoke-r2-cleaner.ts";
import { makeStagingKaraokeR2Observer } from "./staging-karaoke-r2-observer.ts";
import { recordKaraokeRetirementCompletion } from "./staging-karaoke-record-retirement.ts";
import { collectSignedKaraokeReconciliation } from "./staging-karaoke-signing-collector.ts";
import { makeStagingKaraokeSigningReaders } from "./staging-karaoke-signing-readers.ts";

/** Default child entrypoint. Credentials remain in private files or memory. */
export async function runStagingKaraokeCollector(input: KaraokeCollectorInput) {
  const context = loadKaraokeCollectorConfiguration(input);
  const { operator, challenge, assertion, privateKeyPem, journalTrust } = context;
  return collectSignedKaraokeReconciliation({
    trust: operator,
    journal: journalTrust,
    privateKeyPem,
    assertion,
    challenge,
    readers: makeStagingKaraokeSigningReaders(context, input.apiToken),
  });
}

/** Read-only bucket observations, never abort/delete. R2 credentials are
 * separately supplied for the fixed learner-audio staging bucket. */
export async function runStagingKaraokeObservationPass(
  input: KaraokeCollectorInput,
  phase: string | undefined,
) {
  if (
    phase !== "post-fence" &&
    phase !== "pre-reset" &&
    phase !== "retirement" &&
    phase !== "follow-up"
  )
    throw new Error("karaoke_pass_phase_denied");
  const accessKeyId = process.env.KARAOKE_COLLECTOR_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.KARAOKE_COLLECTOR_R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("karaoke_pass_r2_credentials_missing");
  const context = loadKaraokeCollectorConfiguration(input);
  const { operator, challenge, assertion, privateKeyPem, journalTrust } = context;
  return recordKaraokeObservationPass({
    trust: operator,
    journal: journalTrust,
    privateKeyPem,
    assertion,
    challenge,
    phase,
    readers: makeStagingKaraokeSigningReaders(context, input.apiToken),
    r2: makeStagingKaraokeR2Observer({
      accountId: context.config.pins.accountId,
      credentials: { accessKeyId, secretAccessKey },
    }),
  });
}

/** The only exact-key cleanup entrypoint. It runs in the post-fence phase and
 * needs two separately scoped credential pairs: the observer's read pair for
 * before/after evidence and a cleanup pair whose actions are the delete-side
 * receipts. A read-scoped pair cannot clean. */
export async function runStagingKaraokeCleanupPass(input: KaraokeCollectorInput) {
  const readAccessKeyId = process.env.KARAOKE_COLLECTOR_R2_ACCESS_KEY_ID;
  const readSecretAccessKey = process.env.KARAOKE_COLLECTOR_R2_SECRET_ACCESS_KEY;
  const accessKeyId = process.env.KARAOKE_CLEANUP_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.KARAOKE_CLEANUP_R2_SECRET_ACCESS_KEY;
  if (!readAccessKeyId || !readSecretAccessKey)
    throw new Error("karaoke_pass_r2_credentials_missing");
  if (!accessKeyId || !secretAccessKey) throw new Error("karaoke_cleanup_r2_credentials_missing");
  const context = loadKaraokeCollectorConfiguration(input);
  const { operator, challenge, assertion, privateKeyPem, journalTrust } = context;
  return recordKaraokeCleanupPass({
    trust: operator,
    journal: journalTrust,
    privateKeyPem,
    assertion,
    challenge,
    readers: makeStagingKaraokeSigningReaders(context, input.apiToken),
    r2: makeStagingKaraokeR2Observer({
      accountId: context.config.pins.accountId,
      credentials: { accessKeyId: readAccessKeyId, secretAccessKey: readSecretAccessKey },
    }),
    cleaner: makeStagingKaraokeR2Cleaner({
      accountId: context.config.pins.accountId,
      credentials: { accessKeyId, secretAccessKey },
    }),
  });
}

/** Records the all-retired journal milestone from fresh readbacks of all six
 * retired markers under the maintained fence. It composes only the existing
 * signing readers; the reset and release origins additionally require trusted
 * executor/release bindings that have no live composition yet. */
export async function runStagingKaraokeRetirementRecording(input: KaraokeCollectorInput) {
  const context = loadKaraokeCollectorConfiguration(input);
  const { operator, challenge, assertion, privateKeyPem, journalTrust } = context;
  return recordKaraokeRetirementCompletion({
    trust: operator,
    journal: journalTrust,
    privateKeyPem,
    assertion,
    challenge,
    readers: makeStagingKaraokeSigningReaders(context, input.apiToken),
  });
}
