import { test } from "bun:test";

// Signed-journal integration tests fsync real evidence across command phases.
// This wall-clock allowance supports serial low-priority disk work; modeled
// clocks, freshness checks, runtime deadlines and durability stay unchanged.
const JOURNAL_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

export function karaokeJournalIntegrationTest(name: string, run: () => void | Promise<void>) {
  test(name, run, JOURNAL_INTEGRATION_TEST_TIMEOUT_MS);
}
