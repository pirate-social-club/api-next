import { AvatarFailure } from "@pirate/application/avatars/ports";

/** Remove APP/COM segments, including metadata between progressive scans and trailing bytes. */
export function stripAvatarJpegMetadata(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const invalid = () => new AvatarFailure({ reason: "invalid" });
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  let sawScan = false;
  while (at < bytes.length) {
    const start = at;
    if (bytes[at++] !== 0xff) throw invalid();
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === undefined || marker === 0 || marker === 0xd8) throw invalid();
    if (marker === 0xd9) {
      if (!sawScan) throw invalid();
      chunks.push(bytes.subarray(start, at));
      const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }
    const high = bytes[at],
      low = bytes[at + 1];
    if (high === undefined || low === undefined) throw invalid();
    const size = high * 256 + low;
    if (size < 2 || at + size > bytes.length) throw invalid();
    at += size;
    if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe))
      chunks.push(bytes.subarray(start, at));
    if (marker === 0xda) {
      sawScan = true;
      const scanStart = at;
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) {
          at++;
          continue;
        }
        let next = at + 1;
        while (bytes[next] === 0xff) next++;
        const value = bytes[next];
        if (value === 0 || (value !== undefined && value >= 0xd0 && value <= 0xd7)) {
          at = next + 1;
          continue;
        }
        break;
      }
      chunks.push(bytes.subarray(scanStart, at));
    }
  }
  throw invalid();
}
