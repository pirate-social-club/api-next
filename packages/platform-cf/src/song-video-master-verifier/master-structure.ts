/** This is a Worker-specific ceiling, not the broader U.6 storage ceiling. */
export const MAX_SONG_VIDEO_MASTER_BYTES = 24 * 1024 * 1024;
const SAMPLE_RATE = 48_000;
const VIDEO_FRAME_SAMPLES = 1_600; // The admitted command normalizes to 30 fps.
const MAX_VIDEO_FRAMES = 450;
const MAX_CHUNKS = 1_000;

export class SongVideoMasterRejection extends Error {
  constructor(readonly reason: string) {
    super(`Song video master rejected: ${reason}`);
  }
}

type BoxRange = {
  readonly type: string;
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
};

function reject(reason: string): never {
  throw new SongVideoMasterRejection(reason);
}

function topLevelBoxes(bytes: Uint8Array): readonly BoxRange[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: BoxRange[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (boxes.length >= 5 || bytes.byteLength - offset < 8) reject("invalid_box_envelope");
    const size32 = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let size = size32;
    let header = 8;
    if (size32 === 1) {
      if (bytes.byteLength - offset < 16) reject("invalid_box_envelope");
      const wide = view.getBigUint64(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) reject("invalid_box_envelope");
      size = Number(wide);
      header = 16;
    }
    if (size < header || size > bytes.byteLength - offset) reject("invalid_box_envelope");
    boxes.push({ type, start: offset, dataStart: offset + header, end: offset + size });
    offset += size;
  }
  const shape = boxes.map((box) => box.type).join(",");
  if (
    shape !== "ftyp,moov,mdat" &&
    shape !== "ftyp,moov,wide,mdat" &&
    shape !== "ftyp,moov,free,mdat"
  ) {
    reject("unexpected_box_layout");
  }
  const ftyp = boxes[0];
  if (!ftyp || ftyp.end - ftyp.dataStart < 8) reject("invalid_ftyp");
  const brand = String.fromCharCode(...bytes.subarray(ftyp.dataStart, ftyp.dataStart + 4));
  if (brand !== "isom") reject("invalid_ftyp");
  return boxes;
}

function childBoxes(bytes: Uint8Array, start: number, end: number): readonly BoxRange[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: BoxRange[] = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) reject("invalid_child_box");
    const size = view.getUint32(offset);
    if (size < 8 || size > end - offset) reject("invalid_child_box");
    boxes.push({
      type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)),
      start: offset,
      dataStart: offset + 8,
      end: offset + size,
    });
    offset += size;
  }
  return boxes;
}

function findChild(bytes: Uint8Array, parent: BoxRange, type: string): BoxRange {
  const matches = childBoxes(bytes, parent.dataStart, parent.end).filter(
    (box) => box.type === type,
  );
  if (matches.length !== 1) reject(`invalid_${type}_box`);
  return matches[0] as BoxRange;
}

function sampleTimings(
  bytes: Uint8Array,
  moov: BoxRange,
  expectedSamples: number,
): readonly {
  readonly handler: string;
  readonly count: number;
  readonly duration: number;
  readonly trak: BoxRange;
  readonly stbl: BoxRange;
}[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return childBoxes(bytes, moov.dataStart, moov.end)
    .filter((box) => box.type === "trak")
    .map((trak) => {
      const mdia = findChild(bytes, trak, "mdia");
      const hdlr = findChild(bytes, mdia, "hdlr");
      if (hdlr.end - hdlr.dataStart < 12) reject("invalid_hdlr");
      const handler = String.fromCharCode(
        ...bytes.subarray(hdlr.dataStart + 8, hdlr.dataStart + 12),
      );
      if (handler !== "vide" && handler !== "soun") reject("unexpected_tracks");
      const mdhd = findChild(bytes, mdia, "mdhd");
      if (
        mdhd.end - mdhd.dataStart < 20 ||
        view.getUint32(mdhd.dataStart) !== 0 ||
        view.getUint32(mdhd.dataStart + 12) !== SAMPLE_RATE ||
        view.getUint32(mdhd.dataStart + 16) !== expectedSamples
      )
        reject("unexpected_track_shape");
      const minf = findChild(bytes, mdia, "minf");
      const stbl = findChild(bytes, minf, "stbl");
      validateSampleTableBounds(bytes, stbl, handler, expectedSamples);
      const stts = findChild(bytes, stbl, "stts");
      if (stts.end - stts.dataStart < 8 || view.getUint32(stts.dataStart) !== 0) {
        reject("invalid_stts");
      }
      const entries = view.getUint32(stts.dataStart + 4);
      if (entries === 0 || entries > MAX_CHUNKS || stts.end - stts.dataStart !== 8 + entries * 8) {
        reject("invalid_stts");
      }
      let count = 0;
      let duration = 0;
      let videoIndex = 0;
      for (let index = 0; index < entries; index++) {
        const entryCount = view.getUint32(stts.dataStart + 8 + index * 8);
        const delta = view.getUint32(stts.dataStart + 12 + index * 8);
        if (entryCount === 0 || delta === 0) reject("invalid_stts");
        count += entryCount;
        duration += entryCount * delta;
        if (
          !Number.isSafeInteger(duration) ||
          count > (handler === "soun" ? expectedSamples : MAX_VIDEO_FRAMES)
        )
          reject("invalid_stts");
        if (
          handler === "soun" &&
          (entries !== 1 || entryCount !== expectedSamples || delta !== 1)
        ) {
          reject("invalid_stts");
        }
        if (handler === "vide") {
          for (let frame = 0; frame < entryCount; frame++) {
            const required =
              videoIndex === Math.ceil(expectedSamples / VIDEO_FRAME_SAMPLES) - 1
                ? expectedSamples - videoIndex * VIDEO_FRAME_SAMPLES
                : VIDEO_FRAME_SAMPLES;
            if (delta !== required) reject("video_frame_duration");
            videoIndex++;
          }
        }
      }
      return { handler, count, duration, trak, stbl };
    });
}

function validateSampleTableBounds(
  bytes: Uint8Array,
  stbl: BoxRange,
  handler: string,
  expectedSamples: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = childBoxes(bytes, stbl.dataStart, stbl.end);
  const names = boxes.map((box) => box.type).join(",");
  if (
    (handler === "soun" && names !== "stsd,stts,stsc,stsz,stco") ||
    (handler === "vide" &&
      names !== "stsd,stts,stss,stsc,stsz,stco" &&
      names !== "stsd,stts,stsc,stsz,stco")
  )
    reject("unexpected_sample_table");
  for (const box of boxes) {
    if (box.type === "stsz") {
      if (box.end - box.dataStart < 12 || view.getUint32(box.dataStart) !== 0) {
        reject("invalid_stsz");
      }
      const uniformSize = view.getUint32(box.dataStart + 4);
      const count = view.getUint32(box.dataStart + 8);
      if (
        count !==
          (handler === "soun"
            ? expectedSamples
            : Math.ceil(expectedSamples / VIDEO_FRAME_SAMPLES)) ||
        uniformSize !== (handler === "soun" ? 4 : 0) ||
        box.end - box.dataStart !== (handler === "soun" ? 12 : 12 + count * 4)
      )
        reject("invalid_stsz");
    }
    const stride = box.type === "stsc" ? 12 : box.type === "stco" || box.type === "stss" ? 4 : 0;
    if (stride !== 0) {
      if (box.end - box.dataStart < 8 || view.getUint32(box.dataStart) !== 0) {
        reject(`invalid_${box.type}`);
      }
      const count = view.getUint32(box.dataStart + 4);
      if (count === 0 || count > MAX_CHUNKS || box.end - box.dataStart !== 8 + count * stride)
        reject(`invalid_${box.type}`);
    }
  }
}

function validatePcmSpecificBox(bytes: Uint8Array, moov: BoxRange): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found = 0;
  for (const trak of childBoxes(bytes, moov.dataStart, moov.end).filter(
    (box) => box.type === "trak",
  )) {
    const mdia = findChild(bytes, trak, "mdia");
    const minf = findChild(bytes, mdia, "minf");
    const stbl = findChild(bytes, minf, "stbl");
    const stsd = findChild(bytes, stbl, "stsd");
    if (
      stsd.end - stsd.dataStart < 16 ||
      view.getUint32(stsd.dataStart) !== 0 ||
      view.getUint32(stsd.dataStart + 4) !== 1
    )
      reject("invalid_stsd");
    const entries = childBoxes(bytes, stsd.dataStart + 8, stsd.end);
    if (entries.length !== 1) reject("invalid_stsd");
    const entry = entries[0];
    if (entry?.type !== "ipcm") continue;
    found++;
    const configuration = childBoxes(bytes, entry.dataStart + 28, entry.end);
    if (
      entry.end - entry.dataStart !== 84 ||
      view.getUint16(entry.dataStart + 16) !== 2 ||
      view.getUint16(entry.dataStart + 18) !== 16 ||
      view.getUint32(entry.dataStart + 24) !== 48_000 * 65_536 ||
      configuration.length !== 3 ||
      configuration[0]?.type !== "chnl" ||
      configuration[0].end - configuration[0].start !== 22 ||
      configuration[1]?.type !== "pcmC" ||
      configuration[1].end - configuration[1].start !== 14 ||
      view.getUint32(configuration[1].dataStart) !== 0 ||
      bytes[configuration[1].dataStart + 4] !== 1 ||
      bytes[configuration[1].dataStart + 5] !== 16 ||
      configuration[2]?.type !== "btrt" ||
      configuration[2].end - configuration[2].start !== 20
    )
      reject("invalid_pcm_config");
  }
  if (found !== 1) reject("invalid_pcm_config");
}

type TrackInfo = ReturnType<typeof sampleTimings>[number];

function validateTrackShape(
  bytes: Uint8Array,
  track: TrackInfo,
  movieTimescale: number,
  expectedSamples: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trackBoxes = childBoxes(bytes, track.trak.dataStart, track.trak.end);
  if (trackBoxes.map((box) => box.type).join(",") !== "tkhd,edts,mdia")
    reject("unexpected_track_shape");
  const mdia = findChild(bytes, track.trak, "mdia");
  if (
    childBoxes(bytes, mdia.dataStart, mdia.end)
      .map((box) => box.type)
      .join(",") !== "mdhd,hdlr,minf"
  )
    reject("unexpected_track_shape");
  const minf = findChild(bytes, mdia, "minf");
  if (
    childBoxes(bytes, minf.dataStart, minf.end)
      .map((box) => box.type)
      .join(",") !== `${track.handler === "vide" ? "vmhd" : "smhd"},dinf,stbl`
  )
    reject("unexpected_track_shape");
  const edts = findChild(bytes, track.trak, "edts");
  const elst = findChild(bytes, edts, "elst");
  if (
    elst.end - elst.dataStart !== 20 ||
    view.getUint32(elst.dataStart) !== 0 ||
    view.getUint32(elst.dataStart + 4) !== 1 ||
    view.getUint32(elst.dataStart + 8) * SAMPLE_RATE !== expectedSamples * movieTimescale ||
    view.getInt32(elst.dataStart + 12) !== 0 ||
    view.getUint16(elst.dataStart + 16) !== 1 ||
    view.getUint16(elst.dataStart + 18) !== 0
  )
    reject("unexpected_edit_list");
  const stsd = findChild(bytes, track.stbl, "stsd");
  if (
    stsd.end - stsd.dataStart < 16 ||
    view.getUint32(stsd.dataStart) !== 0 ||
    view.getUint32(stsd.dataStart + 4) !== 1
  )
    reject("invalid_stsd");
  const entries = childBoxes(bytes, stsd.dataStart + 8, stsd.end);
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.type !== (track.handler === "vide" ? "avc1" : "ipcm"))
    reject("unexpected_track_shape");
  if (track.handler === "vide") {
    if (
      entry.end - entry.dataStart < 78 ||
      view.getUint16(entry.dataStart + 24) < 1 ||
      view.getUint16(entry.dataStart + 24) > 1_920 ||
      view.getUint16(entry.dataStart + 26) < 1 ||
      view.getUint16(entry.dataStart + 26) > 1_920
    )
      reject("unexpected_track_shape");
    const codecBoxes = childBoxes(bytes, entry.dataStart + 78, entry.end);
    const avcC = codecBoxes.filter((box) => box.type === "avcC");
    if (avcC.length !== 1 || (avcC[0]?.end ?? 0) - (avcC[0]?.dataStart ?? 0) < 7)
      reject("unexpected_track_shape");
  }
}

function trackChunks(
  bytes: Uint8Array,
  track: TrackInfo,
  mdat: BoxRange,
  expectedSamples: number,
): {
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly chunks: readonly Uint8Array[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stsz = findChild(bytes, track.stbl, "stsz");
  const stsc = findChild(bytes, track.stbl, "stsc");
  const stco = findChild(bytes, track.stbl, "stco");
  const sampleSize = view.getUint32(stsz.dataStart + 4);
  const sampleCount = view.getUint32(stsz.dataStart + 8);
  const chunkCount = view.getUint32(stco.dataStart + 4);
  const entryCount = view.getUint32(stsc.dataStart + 4);
  const expectedCount =
    track.handler === "soun" ? expectedSamples : Math.ceil(expectedSamples / VIDEO_FRAME_SAMPLES);
  if (
    sampleCount !== expectedCount ||
    track.count !== expectedCount ||
    sampleSize !== (track.handler === "soun" ? 4 : 0) ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNKS ||
    entryCount < 1 ||
    entryCount > MAX_CHUNKS
  )
    reject("invalid_sample_table");
  const entries: { readonly first: number; readonly perChunk: number }[] = [];
  for (let index = 0; index < entryCount; index++) {
    const start = stsc.dataStart + 8 + index * 12;
    const first = view.getUint32(start);
    const perChunk = view.getUint32(start + 4);
    const description = view.getUint32(start + 8);
    if (
      (index === 0 && first !== 1) ||
      first < 1 ||
      first > chunkCount ||
      (index > 0 && first <= (entries[index - 1]?.first ?? 0)) ||
      perChunk < 1 ||
      description !== 1
    )
      reject("invalid_sample_table");
    entries.push({ first, perChunk });
  }
  const ranges: { start: number; end: number }[] = [];
  const chunks: Uint8Array[] = [];
  let used = 0;
  let run = 0;
  for (let index = 0; index < chunkCount; index++) {
    if (run + 1 < entries.length && entries[run + 1]?.first === index + 1) run++;
    const count = entries[run]?.perChunk ?? 0;
    const start = view.getUint32(stco.dataStart + 8 + index * 4);
    let length = 0;
    if (track.handler === "soun") {
      length = count * 4;
      used += count;
      if (used > sampleCount) reject("invalid_sample_table");
    } else {
      for (let sample = 0; sample < count; sample++) {
        if (used >= sampleCount) reject("invalid_sample_table");
        const size = view.getUint32(stsz.dataStart + 12 + used * 4);
        if (size < 1 || size > MAX_SONG_VIDEO_MASTER_BYTES) reject("invalid_sample_table");
        length += size;
        used++;
      }
    }
    const end = start + length;
    if (start < mdat.dataStart || end > mdat.end || !Number.isSafeInteger(end))
      reject("invalid_sample_extent");
    ranges.push({ start, end });
    if (track.handler === "soun") chunks.push(bytes.subarray(start, end));
  }
  if (used !== sampleCount) reject("invalid_sample_table");
  return { ranges, chunks };
}

export type SongVideoMasterStructure = {
  readonly videoFrameCount: number;
  readonly audioChunkCount: number;
  readonly audioChunks: readonly Uint8Array[];
};

/**
 * Rejects any master outside the admitted PCM-in-MP4 recipe. Audio chunks are
 * returned in sample order; the caller hashes their bytes as soundtrack evidence.
 */
export function inspectSongVideoMasterStructure(
  bytes: Uint8Array,
  expectedSamples: number,
): SongVideoMasterStructure {
  if (
    !Number.isSafeInteger(expectedSamples) ||
    expectedSamples < 3 * SAMPLE_RATE ||
    expectedSamples > 15 * SAMPLE_RATE
  )
    reject("invalid_expected_duration");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SONG_VIDEO_MASTER_BYTES) {
    reject("master_size");
  }
  const boxes = topLevelBoxes(bytes);
  const moov = boxes[1];
  if (moov?.type !== "moov") reject("missing_moov");
  if (
    childBoxes(bytes, moov.dataStart, moov.end)
      .map((box) => box.type)
      .join(",") !== "mvhd,trak,trak,udta"
  )
    reject("unexpected_box_layout");
  validatePcmSpecificBox(bytes, moov);
  const timings = sampleTimings(bytes, moov, expectedSamples);
  if (
    timings.length !== 2 ||
    timings.some((timing) => timing.duration !== expectedSamples) ||
    timings.filter((timing) => timing.handler === "soun").length !== 1 ||
    timings.filter((timing) => timing.handler === "vide").length !== 1
  ) {
    reject("sample_table_duration");
  }
  const mdat = boxes.at(-1);
  if (mdat?.type !== "mdat") reject("missing_mdat");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mvhd = findChild(bytes, moov, "mvhd");
  if (mvhd.end - mvhd.dataStart < 20 || view.getUint32(mvhd.dataStart) !== 0)
    reject("invalid_mvhd");
  const movieTimescale = view.getUint32(mvhd.dataStart + 12);
  if (movieTimescale === 0) reject("invalid_mvhd");
  const video = timings.find((track) => track.handler === "vide");
  const audio = timings.find((track) => track.handler === "soun");
  if (!video || !audio) reject("unexpected_tracks");
  validateTrackShape(bytes, video, movieTimescale, expectedSamples);
  validateTrackShape(bytes, audio, movieTimescale, expectedSamples);
  const videoData = trackChunks(bytes, video, mdat, expectedSamples);
  const audioData = trackChunks(bytes, audio, mdat, expectedSamples);
  const ranges = [...videoData.ranges, ...audioData.ranges].sort(
    (left, right) => left.start - right.start,
  );
  let covered = mdat.dataStart;
  for (const range of ranges) {
    if (range.start !== covered) reject("mdat_sample_coverage");
    covered = range.end;
  }
  if (covered !== mdat.end) reject("mdat_sample_coverage");
  return {
    videoFrameCount: video.count,
    audioChunkCount: audioData.chunks.length,
    audioChunks: audioData.chunks,
  };
}
