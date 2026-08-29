import type { ControlPlaneTransaction } from "@pirate/application";

// Migration 0083 owns this namespace. All learner-audio producers and deletion
// take the same account lock before creating or removing retained audio.
export const LEARNER_AUDIO_ACCOUNT_LOCK_NAMESPACE = 83_000_001;

export const lockLearnerAudioAccount = (transaction: ControlPlaneTransaction, accountId: string) =>
  transaction.execute({
    label: "learner-audio.account-lock",
    text: "SELECT pg_advisory_xact_lock(hashtextextended($1, $2))",
    values: [accountId, LEARNER_AUDIO_ACCOUNT_LOCK_NAMESPACE],
    readonly: false,
  });
