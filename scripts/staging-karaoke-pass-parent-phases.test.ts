import { afterEach, expect } from "bun:test";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import { karaokeJournalIntegrationTest as test } from "./staging-karaoke-journal-test.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import type { KaraokePassPhase } from "./staging-karaoke-observation-pass.ts";
import { verifyRecordedKaraokePass } from "./staging-karaoke-record-pass-cli.ts";

afterEach(disposeMilestoneFixtures);

test("parent verifies every phase through reset, retirement and the required follow-up boundary", async () => {
  const f = makeKaraokeMilestoneFixture();
  const verifyPass = async (phase: KaraokePassPhase) => {
    const priorHead = readKaraokeMaintenanceJournal(f.journal, f.now()).head;
    const started = Date.parse(f.now());
    const result = await f.pass(phase);
    const proof = await verifyRecordedKaraokePass({
      config: f.base.trust,
      journalTrust: f.base.journal,
      priorHead,
      challenge: f.base.challenge,
      phase,
      started,
      nowUtc: f.now(),
    });
    expect(proof.journalHead).toEqual(result.head);
    expect(proof.executionAuthorized).toBe(false);
    return proof;
  };
  await verifyPass("post-fence");
  await verifyPass("pre-reset");
  f.state.identityPresent = false;
  await f.resetOrigin();
  f.state.markers = "retired";
  await verifyPass("retirement");
  await f.retirementOrigin();
  await f.releaseOrigin();
  f.advance(86_400_000);
  expect((await verifyPass("follow-up")).retentionStatus).toBe("observed-stable");
});
