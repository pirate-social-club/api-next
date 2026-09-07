import {
  type KaraokeCollectorInput,
  loadKaraokeCollectorConfiguration,
} from "./staging-karaoke-collector-config.ts";
import { recordKaraokeObservationPass } from "./staging-karaoke-observation-pass.ts";
import { makeStagingKaraokeR2Observer } from "./staging-karaoke-r2-observer.ts";
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
  if (phase !== "post-fence" && phase !== "pre-reset") throw new Error("karaoke_pass_phase_denied");
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
