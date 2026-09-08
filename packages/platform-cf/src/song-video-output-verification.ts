/**
 * Output verification for a rendered song-video master.
 *
 * Sealing a master must not rest on a caller's word about what was produced.
 * This module reads the completed output's actual bytes, computes its digest and
 * length itself, and checks the probe's measured facts against the frozen
 * interval. The master's digest and length are measured here, never supplied by
 * a caller, and no boolean is accepted as evidence anywhere.
 *
 * What this function alone does not establish, stated plainly because an earlier
 * revision overclaimed it: it receives no song identity, no clip start, no
 * attempt and no renderer policy, so matching duration and sample rate cannot
 * distinguish the selected soundtrack from a different song of equal length.
 * Binding output to the frozen work is the composed sealing operation's job in
 * `song-video-render-repository.ts`, which loads that work from persistence.
 *
 * The composed sealing path supplies the ratified U.6 ceiling. This lower-level
 * verifier takes an explicit ceiling so boundary fixtures can exercise rejection
 * without allocating a production-size artifact.
 */

/**
 * Reads completed output bytes with the object version they were read at.
 * Returns null when no completed object exists. The version lets sealing prove
 * it is persisting the same bytes that were verified.
 */
export type SongVideoOutputStore = {
  readonly read: (
    objectKey: string,
  ) => Promise<{ readonly bytes: Uint8Array; readonly objectVersion: string } | null>;
  /**
   * Retrieves an exact recorded version. Downstream consumers resolve a sealed
   * master through this, so the verified bytes remain addressable after later
   * writes to the same key. A store without it cannot preserve verified bytes,
   * and verification refuses rather than pretending a mutable read is immutable.
   */
  readonly readVersion: (objectKey: string, objectVersion: string) => Promise<Uint8Array | null>;
};

/** Measured facts a probe reports about the bytes it was given. */
export type SongVideoOutputProbe = {
  readonly probe: (bytes: Uint8Array) => Promise<SongVideoProbeFacts | null>;
};

export type SongVideoProbeFacts = {
  /** Measured separately, because one container duration hides a short track. */
  readonly videoDurationSamples: number;
  readonly audioDurationSamples: number;
  readonly audioSampleRateHz: number;
  readonly audioChannels: number;
  readonly hasVideoTrack: boolean;
};

/** Surfaces structurally through OutputVerification. */
type VerifiedOutput = {
  readonly objectKey: string;
  readonly objectVersion: string;
  readonly masterSha256: string;
  readonly masterByteLength: number;
  readonly probe: SongVideoProbeFacts;
};

/** Surfaces structurally through OutputVerification. */
type OutputVerificationFailure =
  | { readonly kind: "output_absent"; readonly objectKey: string }
  | { readonly kind: "output_empty"; readonly objectKey: string }
  | {
      readonly kind: "output_exceeds_ceiling";
      readonly byteLength: number;
      readonly ceiling: number;
    }
  | { readonly kind: "output_unprobeable"; readonly objectKey: string }
  | { readonly kind: "ceiling_not_configured"; readonly ceiling: number }
  | {
      readonly kind: "output_duration_not_plan_interval";
      readonly track: "video" | "audio";
      readonly measuredSamples: number;
      readonly planSamples: number;
    }
  | { readonly kind: "output_audio_not_canonical"; readonly sampleRateHz: number }
  | { readonly kind: "output_audio_track_invalid"; readonly channels: number }
  | { readonly kind: "output_has_no_video_track" }
  | { readonly kind: "output_is_the_source"; readonly sha256: string }
  | { readonly kind: "output_version_not_addressable"; readonly objectVersion: string }
  | { readonly kind: "output_version_bytes_differ"; readonly objectVersion: string };

export type OutputVerification =
  | { readonly verified: true; readonly output: VerifiedOutput }
  | { readonly verified: false; readonly failure: OutputVerificationFailure };

const CANONICAL_SAMPLE_RATE_HZ = 48_000;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifies a completed output against the frozen work it claims to be.
 *
 * Every fact used downstream is measured here rather than accepted: the digest
 * and length come from the bytes, and the duration, sample rate and track
 * presence come from probing those same bytes. Missing, empty, corrupt,
 * oversized or wrongly bound output is refused, and a master that turns out to
 * be the source is refused as a substituted identity.
 */
export async function verifyRenderedOutput(input: {
  readonly store: SongVideoOutputStore;
  readonly prober: SongVideoOutputProbe;
  readonly objectKey: string;
  /** Frozen facts the output must match. */
  readonly planClipDurationSamples: number;
  readonly sourceSha256: string;
  /** U.6's configured ceiling, supplied per call and never defaulted. */
  readonly masterCeilingBytes: number;
}): Promise<OutputVerification> {
  // Validate the supplied ceiling before reading anything. A NaN or otherwise
  // unusable value must refuse rather than pass every comparison silently; this
  // is the same failure the acceptance check had, at a new boundary.
  if (!Number.isSafeInteger(input.masterCeilingBytes) || input.masterCeilingBytes <= 0) {
    return {
      verified: false,
      failure: { kind: "ceiling_not_configured", ceiling: input.masterCeilingBytes },
    };
  }
  const read = await input.store.read(input.objectKey);
  if (read === null) {
    return { verified: false, failure: { kind: "output_absent", objectKey: input.objectKey } };
  }
  const { bytes, objectVersion } = read;
  if (objectVersion.trim().length === 0) {
    return { verified: false, failure: { kind: "output_absent", objectKey: input.objectKey } };
  }
  if (bytes.byteLength === 0) {
    return { verified: false, failure: { kind: "output_empty", objectKey: input.objectKey } };
  }
  if (bytes.byteLength > input.masterCeilingBytes) {
    return {
      verified: false,
      failure: {
        kind: "output_exceeds_ceiling",
        byteLength: bytes.byteLength,
        ceiling: input.masterCeilingBytes,
      },
    };
  }
  const masterSha256 = await sha256Hex(bytes);
  if (masterSha256 === input.sourceSha256) {
    return { verified: false, failure: { kind: "output_is_the_source", sha256: masterSha256 } };
  }
  const probe = await input.prober.probe(bytes);
  if (probe === null) {
    return { verified: false, failure: { kind: "output_unprobeable", objectKey: input.objectKey } };
  }
  if (!probe.hasVideoTrack) {
    return { verified: false, failure: { kind: "output_has_no_video_track" } };
  }
  if (probe.audioSampleRateHz !== CANONICAL_SAMPLE_RATE_HZ) {
    return {
      verified: false,
      failure: { kind: "output_audio_not_canonical", sampleRateHz: probe.audioSampleRateHz },
    };
  }
  if (!Number.isSafeInteger(probe.audioChannels) || probe.audioChannels < 1) {
    return {
      verified: false,
      failure: { kind: "output_audio_track_invalid", channels: probe.audioChannels },
    };
  }
  // A partial render is the case these catch: bytes exist and hash cleanly, but
  // a track does not cover the frozen interval. Both tracks are checked, because
  // a single container duration hides a short audio or video track.
  for (const [track, measuredSamples] of [
    ["video", probe.videoDurationSamples],
    ["audio", probe.audioDurationSamples],
  ] as const) {
    if (
      !Number.isSafeInteger(measuredSamples) ||
      measuredSamples !== input.planClipDurationSamples
    ) {
      return {
        verified: false,
        failure: {
          kind: "output_duration_not_plan_interval",
          track,
          measuredSamples,
          planSamples: input.planClipDurationSamples,
        },
      };
    }
  }
  // The recorded version must be independently retrievable and identical, or the
  // identity is not immutable and nothing downstream could resolve these bytes.
  const byVersion = await input.store.readVersion(input.objectKey, objectVersion);
  if (byVersion === null) {
    return {
      verified: false,
      failure: { kind: "output_version_not_addressable", objectVersion },
    };
  }
  if ((await sha256Hex(byVersion)) !== masterSha256) {
    return { verified: false, failure: { kind: "output_version_bytes_differ", objectVersion } };
  }
  return {
    verified: true,
    output: {
      objectKey: input.objectKey,
      objectVersion,
      masterSha256,
      masterByteLength: bytes.byteLength,
      probe,
    },
  };
}
