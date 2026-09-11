import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeResetVerification } from "./staging-karaoke-record-reset.ts";
import { bindResetCompletionToExecution } from "./staging-karaoke-reset-binding.ts";

/**
 * These build real temporary directories and run signing and journal work
 * against them, which is well past bun's five-second default when the machine
 * is busy. The budget is explicit so the suite fails on a real hang rather than
 * on load from another lane.
 */
const KARAOKE_IO_BUDGET_MS = 60_000;

afterEach(disposeMilestoneFixtures);

test(
  "the concrete reset binding refuses any execution this process did not own",
  async () => {
    const fixture = makeKaraokeMilestoneFixture();
    const { base, pass, state, journal, now } = fixture;
    await pass("post-fence");
    await pass("pre-reset");
    state.identityPresent = false;
    const prior = readKaraokeMaintenanceJournal(journal, now());
    await expect(
      recordKaraokeResetVerification({
        ...base,
        verifyResetCompletion: bindResetCompletionToExecution({}),
      }),
    ).rejects.toThrow("reset_executor_completion_not_owned");
    expect(readKaraokeMaintenanceJournal(journal, now()).head).toEqual(prior.head);
  },
  KARAOKE_IO_BUDGET_MS,
);
