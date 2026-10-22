import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  IANA_TLD_SNAPSHOT,
  IANA_TLD_SNAPSHOT_SHA256,
  IANA_TLD_SNAPSHOT_VERSION_LINE,
} from "./hns-iana-tld-snapshot.ts";
import { isReservedHnsRoot } from "./hns-reserved-roots.ts";

const snapshotLines = IANA_TLD_SNAPSHOT.split("\n");
const snapshotTlds = snapshotLines.slice(1, -1);

describe("HNS reserved roots", () => {
  test("bundles IANA's TLD list byte for byte under its pinned version and digest", () => {
    expect(createHash("sha256").update(IANA_TLD_SNAPSHOT, "ascii").digest("hex")).toBe(
      IANA_TLD_SNAPSHOT_SHA256,
    );
    expect(IANA_TLD_SNAPSHOT_SHA256).toBe(
      "ef731da5bd52d570d5fdf7b8737e06ed661ed65fbef60f7ad9f26063a49efb6f",
    );
    expect(snapshotLines[0]).toBe(IANA_TLD_SNAPSHOT_VERSION_LINE);
    expect(IANA_TLD_SNAPSHOT_VERSION_LINE).toMatch(
      /^# Version [0-9]{10}, Last Updated [A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4} UTC$/u,
    );
    expect(snapshotLines.at(-1)).toBe("");
    expect(snapshotTlds.length).toBeGreaterThan(1_000);
    for (const tld of snapshotTlds) {
      expect(tld).toMatch(/^(?:[A-Z]{2,63}|XN--[A-Z0-9]+(?:-[A-Z0-9]+)*)$/u);
    }
    expect([...snapshotTlds].sort()).toEqual(snapshotTlds);
    expect(new Set(snapshotTlds).size).toBe(snapshotTlds.length);
  });

  test("reserves every snapshot TLD in its lowercase form", () => {
    for (const tld of snapshotTlds) expect(isReservedHnsRoot(tld.toLowerCase())).toBe(true);
    for (const tld of ["com", "box", "arpa", "xn--p1ai", "zw"]) {
      expect(isReservedHnsRoot(tld)).toBe(true);
    }
  });

  test("reserves the other name systems, special-use names and private-network names", () => {
    for (const root of [
      "eth",
      "box",
      "wei",
      "gwei",
      "tez",
      "onion",
      "local",
      "localhost",
      "test",
      "invalid",
      "example",
      "arpa",
      "alt",
      "internal",
      "corp",
      "home",
      "mail",
      "lan",
      "intranet",
      "private",
      "localdomain",
    ]) {
      expect(isReservedHnsRoot(root)).toBe(true);
    }
  });

  test("leaves Handshake roots that collide with nothing", () => {
    for (const root of ["8s28", "a18n", "pirate", "xn--pokmon-dva", "jazleeuw"]) {
      expect(isReservedHnsRoot(root)).toBe(false);
    }
  });
});
