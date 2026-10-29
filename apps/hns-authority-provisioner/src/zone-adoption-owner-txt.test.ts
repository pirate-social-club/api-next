import { expect, test } from "bun:test";
import { encoder, sha256, world } from "./zone-adoption-command-fixture.ts";

test("the actual owner TXT command rejects changed review bytes before any database or provider action", async () => {
  const { run, files, statements, providerCalls } = await world();
  files.set("/var/lib/observation.json", encoder.encode("unread observation"));
  const reviewed = encoder.encode('{"review":"original"}');
  files.set("/var/lib/owner-txt.json", encoder.encode('{"review":"changed"}'));
  expect(
    await run(
      "adopt",
      "--observation",
      "/var/lib/observation.json",
      "--expect-result-sha256",
      "a".repeat(64),
      "--expect-delta",
      "staging_owner_txt_refreshed",
      "--mode",
      "commit",
      "--owner-txt",
      "/var/lib/owner-txt.json",
      "--expect-owner-txt-sha256",
      await sha256(reviewed),
    ),
  ).toMatchObject({
    code: 2,
    report: { outcome: "refused", reason: "the owner TXT is not the one that was reviewed" },
  });
  expect(statements).toEqual([]);
  expect(providerCalls).toEqual([]);
});
