import { afterEach, expect, test } from "bun:test";
import { readKaraokeMaintenanceJournal } from "./karaoke-maintenance-journal.ts";
import {
  disposeMilestoneFixtures,
  makeKaraokeMilestoneFixture,
} from "./staging-karaoke-milestone-fixture.ts";
import { recordKaraokeResetVerification } from "./staging-karaoke-record-reset.ts";
import { bindResetCompletionToExecution } from "./staging-karaoke-reset-binding.ts";

afterEach(disposeMilestoneFixtures);

test("the concrete reset binding refuses any execution this process did not own", async () => {
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
});
