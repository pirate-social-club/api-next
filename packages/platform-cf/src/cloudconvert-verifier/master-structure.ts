import { createFile, type Sample } from "mp4box";

/** This is a Worker-specific ceiling, not the broader U.6 storage ceiling. */
export const MAX_CLOUDCONVERT_MASTER_BYTES = 24 * 1024 * 1024;
const SAMPLE_RATE = 48_000;
const VIDEO_FRAME_SAMPLES = 1_600; // The admitted command normalizes to 30 fps.
const MAX_VIDEO_FRAMES = 450;
const MAX_CHUNKS = 1_000;

export class CloudConvertMasterRejection extends Error {
  constructor(readonly reason: string) {
    super(`CloudConvert master rejected: ${reason}`);
  }
}

type BoxRange = {
  readonly type: string;
  readonly start: number;
  readonly dataStart: number;
  readonly end: number;
};

function reject(reason: string): never {
  throw new CloudConvertMasterRejection(reason);
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
      }
      return { handler, count, duration };
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

function validateSamples(
  samples: readonly Sample[],
  expectedSamples: number,
  track: "video",
  mdat: BoxRange,
): readonly { readonly start: number; readonly end: number }[] {
  const maximum = MAX_VIDEO_FRAMES;
  if (samples.length === 0 || samples.length > maximum) reject(`${track}_sample_count`);
  if (samples.length !== Math.ceil(expectedSamples / VIDEO_FRAME_SAMPLES)) {
    reject("video_frame_count");
  }
  let cursor = 0;
  const ranges = [];
  for (const [index, sample] of samples.entries()) {
    if (
      sample.timescale !== SAMPLE_RATE ||
      sample.dts !== cursor ||
      sample.cts !== cursor ||
      !Number.isSafeInteger(sample.duration) ||
      sample.duration <= 0 ||
      !Number.isSafeInteger(sample.offset) ||
      !Number.isSafeInteger(sample.size) ||
      sample.size <= 0 ||
      sample.offset < mdat.dataStart ||
      sample.offset + sample.size > mdat.end ||
      sample.data?.byteLength !== sample.size
    )
      reject(`${track}_sample_invalid`);
    const required = index === samples.length - 1 ? expectedSamples - cursor : VIDEO_FRAME_SAMPLES;
    if (sample.duration !== required) reject("video_frame_duration");
    cursor += sample.duration;
    ranges.push({ start: sample.offset, end: sample.offset + sample.size });
  }
  if (cursor !== expectedSamples) reject(`${track}_duration`);
  return ranges;
}

export type CloudConvertMasterStructure = {
  readonly videoFrameCount: number;
  readonly audioChunkCount: number;
  readonly audioChunks: readonly Uint8Array[];
};

/**
 * Rejects any master outside the admitted PCM-in-MP4 recipe. Audio chunks are
 * returned in sample order; the caller hashes their bytes as soundtrack evidence.
 */
export function inspectCloudConvertMasterStructure(
  bytes: Uint8Array,
  expectedSamples: number,
): CloudConvertMasterStructure {
  if (
    !Number.isSafeInteger(expectedSamples) ||
    expectedSamples < 3 * SAMPLE_RATE ||
    expectedSamples > 15 * SAMPLE_RATE
  )
    reject("invalid_expected_duration");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLOUDCONVERT_MASTER_BYTES) {
    reject("master_size");
  }
  const boxes = topLevelBoxes(bytes);
  const moov = boxes[1];
  if (moov?.type !== "moov") reject("missing_moov");
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

  const file = createFile();
  let parseError = false;
  let ready = false;
  const packets = new Map<number, Sample[]>();
  file.onError = () => {
    parseError = true;
  };
  file.onReady = (movie) => {
    ready = true;
    if (
      movie.tracks.length !== 2 ||
      movie.videoTracks.length !== 1 ||
      movie.tracks.filter((track) => track.codec === "ipcm").length !== 1
    ) {
      return;
    }
    const video = movie.videoTracks[0];
    if (!video) return;
    packets.set(video.id, []);
    file.setExtractionOptions(video.id, null, { nbSamples: 1 });
    file.start();
  };
  file.onSamples = (id, _user, samples) => {
    const existing = packets.get(id);
    if (!existing) {
      parseError = true;
      return;
    }
    if (existing.length + samples.length > MAX_VIDEO_FRAMES) {
      parseError = true;
      return;
    }
    existing.push(...samples);
  };
  try {
    const buffer = Object.assign(bytes.slice().buffer, { fileStart: 0 });
    file.appendBuffer(buffer);
    file.flush();
  } catch {
    reject("unparseable_master");
  }
  if (parseError || !ready) reject("unparseable_master");
  const movie = file.getInfo();
  if (
    movie.isFragmented ||
    movie.tracks.length !== 2 ||
    movie.videoTracks.length !== 1 ||
    movie.tracks.filter((track) => track.codec === "ipcm").length !== 1
  )
    reject("unexpected_tracks");
  const video = movie.videoTracks[0];
  const audio = movie.tracks.find((track) => track.codec === "ipcm");
  if (!video || !audio) reject("unexpected_tracks");
  if (
    !video.codec.startsWith("avc1.") ||
    audio.codec !== "ipcm" ||
    video.timescale !== SAMPLE_RATE ||
    audio.timescale !== SAMPLE_RATE ||
    video.duration !== expectedSamples ||
    audio.duration !== expectedSamples ||
    audio.nb_samples !== expectedSamples ||
    !video.video ||
    video.video.width < 1 ||
    video.video.width > 1_920 ||
    video.video.height < 1 ||
    video.video.height > 1_920
  )
    reject("unexpected_track_shape");
  for (const track of [video, audio]) {
    const edits = track.edits;
    if (
      edits?.length !== 1 ||
      edits[0]?.media_time !== 0 ||
      edits[0].media_rate_integer !== 1 ||
      edits[0].media_rate_fraction !== 0 ||
      edits[0].segment_duration * SAMPLE_RATE !== expectedSamples * movie.timescale
    )
      reject("unexpected_edit_list");
  }
  const videoSamples = packets.get(video.id);
  if (!videoSamples || videoSamples.length !== video.nb_samples) reject("missing_samples");
  if (
    !timings.some((timing) => timing.handler === "vide" && timing.count === videoSamples.length) ||
    !timings.some((timing) => timing.handler === "soun" && timing.count === expectedSamples)
  )
    reject("sample_table_count");
  type AudioTable = {
    stco: { chunk_offsets: number[] };
    stsc: {
      first_chunk: number[];
      samples_per_chunk: number[];
      sample_description_index: number[];
    };
    stsz: { sample_size: number; sample_count: number };
  };
  const parsed = file as unknown as {
    moov: { traks: { mdia: { hdlr: { handler: string }; minf: { stbl: AudioTable } } }[] };
  };
  const audioTable = parsed.moov.traks.find((trak) => trak.mdia.hdlr.handler === "soun")?.mdia.minf
    .stbl;
  if (
    !audioTable ||
    audioTable.stsz.sample_size !== 4 ||
    audioTable.stsz.sample_count !== expectedSamples
  )
    reject("invalid_pcm_table");
  const offsets = audioTable.stco.chunk_offsets;
  const first = audioTable.stsc.first_chunk;
  const perChunk = audioTable.stsc.samples_per_chunk;
  const descriptions = audioTable.stsc.sample_description_index;
  if (
    offsets.length === 0 ||
    offsets.length > MAX_CHUNKS ||
    first.length === 0 ||
    first.length > MAX_CHUNKS ||
    first.length !== perChunk.length ||
    first.length !== descriptions.length ||
    first[0] !== 1
  ) {
    reject("invalid_pcm_chunks");
  }
  for (let index = 0; index < first.length; index++) {
    const current = first[index] ?? 0;
    if (
      current < 1 ||
      current > offsets.length ||
      (index > 0 && current <= (first[index - 1] ?? 0)) ||
      !Number.isSafeInteger(perChunk[index]) ||
      (perChunk[index] ?? 0) < 1 ||
      descriptions[index] !== 1
    )
      reject("invalid_pcm_chunks");
  }
  const audioChunks: Uint8Array[] = [];
  const audioRanges: { start: number; end: number }[] = [];
  let sampleCount = 0;
  let entry = 0;
  for (let index = 0; index < offsets.length; index++) {
    while (entry + 1 < first.length && first[entry + 1] === index + 1) entry++;
    const count = perChunk[entry] ?? Number.NaN;
    const start = offsets[index] ?? Number.NaN;
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(start) ||
      descriptions[entry] !== 1 ||
      (entry + 1 < first.length && (first[entry + 1] ?? 0) <= index + 1)
    )
      reject("invalid_pcm_chunks");
    const end = start + count * 4;
    if (start < mdat.dataStart || end > mdat.end || end < start) reject("invalid_pcm_chunks");
    sampleCount += count;
    if (sampleCount > expectedSamples) reject("invalid_pcm_chunks");
    audioChunks.push(bytes.subarray(start, end));
    audioRanges.push({ start, end });
  }
  if (sampleCount !== expectedSamples) reject("invalid_pcm_chunks");
  const ranges = [
    ...validateSamples(videoSamples, expectedSamples, "video", mdat),
    ...audioRanges,
  ].sort((left, right) => left.start - right.start);
  let covered = mdat.dataStart;
  for (const range of ranges) {
    if (range.start !== covered) reject("mdat_sample_coverage");
    covered = range.end;
  }
  if (covered !== mdat.end) reject("mdat_sample_coverage");
  return {
    videoFrameCount: videoSamples.length,
    audioChunkCount: audioChunks.length,
    audioChunks,
  };
}
