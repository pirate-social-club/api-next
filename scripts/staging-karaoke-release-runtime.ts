import {
  openKaraokePrivateArtifacts,
  readKaraokePrivateReleaseClaim,
} from "./karaoke-private-artifacts.ts";
import { openKaraokePrivateDirectory } from "./karaoke-private-directory.ts";
import { openKaraokePrivateWriter } from "./karaoke-private-writer.ts";
import {
  type KaraokeCollectorInput,
  loadKaraokeCollectorConfiguration,
} from "./staging-karaoke-collector-config.ts";
import {
  makeKaraokeReleaseBinding,
  makeKaraokeReleaseEvidenceStore,
  recordKaraokeFenceReleaseThroughBinding,
} from "./staging-karaoke-release-binding.ts";
import { loadKaraokeReleaseConfiguration } from "./staging-karaoke-release-config.ts";
import { makeKaraokeDatabaseRelease } from "./staging-karaoke-release-database.ts";
import { makeKaraokeIngressRelease } from "./staging-karaoke-release-ingress.ts";
import { makeKaraokeProducerRelease } from "./staging-karaoke-release-producers.ts";
import { makeStagingKaraokeSigningReaders } from "./staging-karaoke-signing-readers.ts";

/** Factories validate configuration without provider calls; the authenticated
 * origin admits the ceremony before any surface mutation. */
export async function runStagingKaraokeRelease(input: KaraokeCollectorInput) {
  const context = loadKaraokeCollectorConfiguration(input);
  const config = loadKaraokeReleaseConfiguration(context);
  const { operator, challenge, assertion, privateKeyPem, journalTrust } = context;
  const readers = makeStagingKaraokeSigningReaders(context, input.apiToken);
  const transport = { accountId: context.config.pins.accountId, apiToken: input.apiToken };
  const database = makeKaraokeDatabaseRelease({
    ...config.restoration.database,
    reviewedGrantDigest: config.plan.reviewedGrantDigest,
  });
  const producers = makeKaraokeProducerRelease({
    ...transport,
    plan: config.plan,
    schedules: config.restoration.producers.schedules,
  });
  const ingress = makeKaraokeIngressRelease({
    ...transport,
    applicationId: config.plan.ingressApplicationId,
    restoration: config.restoration.ingress,
  });
  const observed = (surface: typeof database | typeof producers | typeof ingress) => async () => {
    if ((await surface.observeRestored()) === "restored") return "restored" as const;
    // A failed restored-state read is not a held-fence proof. Only the same
    // complete collector used at admission may establish this alternative.
    try {
      await readers.observeMaintainedFence();
      return "fenced" as const;
    } catch {
      return "uncertain" as const;
    }
  };
  const resources: { close(): void }[] = [];
  try {
    const anchor = openKaraokePrivateDirectory(journalTrust.directory);
    resources.push(anchor);
    const store = openKaraokePrivateArtifacts(journalTrust.directory);
    resources.push(store);
    const writer = openKaraokePrivateWriter(journalTrust.directory);
    resources.push(writer);
    const evidence = makeKaraokeReleaseEvidenceStore(
      journalTrust.directory,
      privateKeyPem,
      operator.collectorPublicKeyPem,
      (bytes) => {
        writer.putArtifact(bytes);
      },
      () => store.names(),
      (name) =>
        name === "release-claim.json"
          ? readKaraokePrivateReleaseClaim(anchor)
          : store.read(name, 262_144),
    );
    const binding = makeKaraokeReleaseBinding({
      plan: config.plan,
      readers,
      evidence,
      surfaces: {
        database: database.execute,
        producers: producers.execute,
        ingress: ingress.execute,
      },
      observeRestored: {
        database: observed(database),
        producers: observed(producers),
        ingress: observed(ingress),
      },
    });
    return await recordKaraokeFenceReleaseThroughBinding({
      releasePlanDigest: config.approvedPlanDigest,
      trust: operator,
      journal: journalTrust,
      privateKeyPem,
      assertion,
      challenge,
      readers,
      binding,
    });
  } finally {
    for (const resource of resources.reverse()) resource.close();
  }
}
