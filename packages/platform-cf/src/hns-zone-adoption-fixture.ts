/**
 * A small canonical authority zone for tests of zone adoption: a root with
 * its SOA, an app host and a wildcard owner, with or without the two wildcard
 * address-family records and the NSEC bitmap that goes with them. It is what
 * the canonical zone encoder produces for such a zone, written out by hand so
 * a test can vary the serial and the records.
 */
const hex = (bytes: readonly number[]) =>
  bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
const wireName = (value: string) =>
  hex([
    ...value.split(".").flatMap((label) => [label.length, ...new TextEncoder().encode(label)]),
    0,
  ]);
const nsec = (next: string, types: readonly number[]) => {
  const bitmap = new Array<number>(Math.floor(Math.max(...types) / 8) + 1).fill(0);
  for (const type of types)
    bitmap[Math.floor(type / 8)] = (bitmap[Math.floor(type / 8)] ?? 0) | (0x80 >> (type % 8));
  return `${wireName(next)}${hex([0, bitmap.length, ...bitmap])}`;
};

export function hnsZoneAdoptionFixtureZone(
  root: string,
  serial: number,
  wildcardFamily: boolean,
): Uint8Array {
  const soa = `${wireName(`ns1.${root}`)}${wireName(`hostmaster.${root}`)}${serial
    .toString(16)
    .padStart(8, "0")}${"00000e10".repeat(4)}`;
  const wildcard = `*.${root}`;
  return new TextEncoder().encode(
    JSON.stringify({
      version: "pirate-hns-canonical-authority-zone-v1",
      root_label: root,
      records: [
        [root, 1, 1, 300, "c000020a"],
        [root, 6, 1, 300, soa],
        [root, 47, 1, 300, nsec(wildcard, [1, 6, 46, 47])],
        [wildcard, 1, 1, 300, "c000020a"],
        ...(wildcardFamily ? [[wildcard, 28, 1, 300, "00000000000000000000ffffc000020a"]] : []),
        [
          wildcard,
          47,
          1,
          300,
          nsec(`app.${root}`, wildcardFamily ? [1, 28, 46, 47, 65] : [1, 46, 47]),
        ],
        ...(wildcardFamily
          ? [[wildcard, 65, 1, 300, "0001000001000c02683208687474702f312e31"]]
          : []),
        [`app.${root}`, 1, 1, 300, "c000020a"],
        [`app.${root}`, 47, 1, 300, nsec(root, [1, 46, 47])],
      ],
    }),
  );
}
