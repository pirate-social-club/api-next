const maximumPacketBytes = 4 * 1_024 * 1_024;
const maximumNalUnits = 256;

export function parseFfprobeHexdump(input: string): Uint8Array {
  const bytes: number[] = [];
  for (const line of input.split("\n")) {
    const match = /^([0-9a-fA-F]{8}):\s((?:[0-9a-fA-F]{4}\s?){1,8})/.exec(line);
    if (!match) continue;
    const expectedOffset = Number.parseInt(match[1] ?? "", 16);
    if (expectedOffset !== bytes.length) throw new Error("ffprobe packet hexdump is discontinuous");
    const hex = (match[2] ?? "").replaceAll(/\s/g, "");
    for (let offset = 0; offset < hex.length; offset += 2) {
      bytes.push(Number.parseInt(hex.slice(offset, offset + 2), 16));
      if (bytes.length > maximumPacketBytes) throw new Error("H.264 packet exceeds probe bound");
    }
  }
  if (bytes.length === 0) throw new Error("ffprobe packet hexdump is empty");
  return Uint8Array.from(bytes);
}

export function readAvccNalUnitTypes(packet: Uint8Array, lengthSize = 4): readonly number[] {
  // This ingress is an MP4 packet read by ffprobe, so H.264 NAL units use the
  // AVCC length-prefixed representation declared by the sample entry. Annex B
  // start codes belong to elementary streams and are deliberately unsupported.
  if (packet.byteLength === 0 || packet.byteLength > maximumPacketBytes) {
    throw new RangeError("H.264 packet size is outside the probe bound");
  }
  if (lengthSize !== 4) throw new RangeError("copy profile requires four-byte AVCC lengths");

  const types: number[] = [];
  let offset = 0;
  while (offset < packet.byteLength) {
    if (offset + lengthSize > packet.byteLength) throw new Error("truncated AVCC NAL length");
    const length =
      ((packet[offset] ?? 0) * 0x1_00_00_00 +
        (packet[offset + 1] ?? 0) * 0x1_00_00 +
        (packet[offset + 2] ?? 0) * 0x1_00 +
        (packet[offset + 3] ?? 0)) >>>
      0;
    offset += lengthSize;
    if (length < 1 || offset + length > packet.byteLength) {
      throw new Error("invalid AVCC NAL length");
    }
    const header = packet[offset] ?? 0;
    if ((header & 0x80) !== 0) throw new Error("forbidden H.264 NAL header bit is set");
    const type = header & 0x1f;
    if (type === 0) throw new Error("invalid H.264 NAL unit type");
    types.push(type);
    if (types.length > maximumNalUnits) throw new Error("H.264 packet exceeds NAL count bound");
    offset += length;
  }
  return types;
}

export function isH264IdrAccessUnit(packet: Uint8Array): boolean {
  return readAvccNalUnitTypes(packet).includes(5);
}
