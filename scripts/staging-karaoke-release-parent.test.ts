import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { verifyKaraokeReleaseAttestation } from "./staging-karaoke-record-release-cli.ts";

afterEach(disposeMilestoneFixtures);
test("parent verifies the fresh signed release, challenge and plan rather than child exit", async () => {
  const f = makeKaraokeMilestoneFixture();
  await f.pass("post-fence");
  await f.pass("pre-reset");
  f.state.identityPresent = false;
  await f.resetOrigin();
  f.state.markers = "retired";
  await f.pass("retirement");
  await f.retirementOrigin();
  const prior = readKaraokeMaintenanceJournal(f.journal, f.now());
  const started = Date.parse(f.now());
  await f.releaseOrigin();
  const journal = readKaraokeMaintenanceJournal(f.journal, f.now());
  const input = {
    prior,
    journal,
    trust: f.base.trust,
    challenge: f.base.challenge,
    planDigest: f.base.releasePlanDigest,
    started,
    now: Date.parse(f.now()),
  };
  expect((await verifyKaraokeReleaseAttestation(input)).executionAuthorized).toBe(false);
  await expect(verifyKaraokeReleaseAttestation({ ...input, journal: prior })).rejects.toThrow(
    "attestation_denied",
  );
  await expect(
    verifyKaraokeReleaseAttestation({ ...input, planDigest: "b".repeat(64) }),
  ).rejects.toThrow("attestation_denied");
  await expect(
    verifyKaraokeReleaseAttestation({
      ...input,
      challenge: { ...input.challenge, challenge: "b".repeat(64) },
    }),
  ).rejects.toThrow("attestation_denied");
  await expect(
    verifyKaraokeReleaseAttestation({ ...input, now: started + 60_001 }),
  ).rejects.toThrow("attestation_denied");
});
