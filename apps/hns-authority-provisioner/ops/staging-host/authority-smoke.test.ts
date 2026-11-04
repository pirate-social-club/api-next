import { expect, test } from "bun:test";
import { requireOwnedSecondary, requireSmokeExecution } from "./authority-smoke.ts";

test("host smoke requires exact explicit execution and cannot accept a remote target", () => {
  expect(() => requireSmokeExecution(["--execute-host"])).not.toThrow();
  for (const args of [[], ["--execute-host", "https://remote.invalid"], ["--execute-local"]]) {
    expect(() => requireSmokeExecution(args)).toThrow();
  }
});

test("secondary cleanup refuses fixture identity, source and challenge drift", () => {
  const root = `e2e${"a".repeat(24)}`;
  const challenge = "pirate-verification=test";
  const zone = {
    name: `${root}.`,
    kind: "Slave",
    account: "isolated-staging-fixture",
    masters: ["127.0.0.21"],
    rrsets: [
      {
        name: `_pirate.${root}.`,
        type: "TXT",
        records: [{ content: JSON.stringify(challenge), disabled: false }],
      },
    ],
  };
  expect(() => requireOwnedSecondary(zone, root, challenge)).not.toThrow();
  for (const drift of [
    null,
    {},
    { ...zone, kind: "Master" },
    { ...zone, account: "another" },
    { ...zone, masters: ["192.0.2.1"] },
    { ...zone, rrsets: [] },
    { ...zone, name: "other." },
  ]) {
    expect(() => requireOwnedSecondary(drift, root, challenge)).toThrow();
  }
  expect(() => requireOwnedSecondary(zone, root, "different")).toThrow();
});
