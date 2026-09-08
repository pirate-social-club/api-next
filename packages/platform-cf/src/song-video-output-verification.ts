/**
 * Output verification for a rendered song-video master.
 *
 * Sealing a master must not rest on a caller's word about what was produced.
 * This module reads the completed output's actual bytes, computes its digest and
 * length itself, probes it, and binds the measured facts to the frozen song,
 * source, interval and renderer policy. A caller-supplied verification flag
 * cannot satisfy any of it: no boolean is accepted as evidence anywhere here.
 *
 * U.6 stays unresolved. The byte ceiling is supplied per verification and is
 * never defaulted, so fixture verification can proceed while operational sealing
 * still waits on a ratified value.
 */

/** Reads completed output bytes. Returns null when no completed object exists. */
export type SongVideoOutputStore = {
  readonly read: (objectKey: string) => Promise<Uint8Array | null>;
};

/** Measured facts a probe reports about the bytes it was given. */
export type SongVideoOutputProbe = {
  readonly probe: (bytes: Uint8Array) => Promise<SongVideoProbeFacts | null>;
};

export type SongVideoProbeFacts = {
  readonly containerDurationSamples: number;
  readonly audioSampleRateHz: number;
  readonly audioChannels: number;
  readonly hasVideoTrack: boolean;
};

/** Surfaces structurally through OutputVerification. */
type VerifiedOutput = {
  readonly objectKey: string;
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
  | {
      readonly kind: "output_duration_not_plan_interval";
      readonly measuredSamples: number;
      readonly planSamples: number;
    }
  | { readonly kind: "output_audio_not_canonical"; readonly sampleRateHz: number }
  | { readonly kind: "output_has_no_video_track" }
  | { readonly kind: "output_is_the_source"; readonly sha256: string };

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
  const bytes = await input.store.read(input.objectKey);
  if (bytes === null) {
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
  // A partial render is the case this catches: bytes exist and hash cleanly, but
  // the timeline is not the interval that was frozen.
  if (probe.containerDurationSamples !== input.planClipDurationSamples) {
    return {
      verified: false,
      failure: {
        kind: "output_duration_not_plan_interval",
        measuredSamples: probe.containerDurationSamples,
        planSamples: input.planClipDurationSamples,
      },
    };
  }
  return {
    verified: true,
    output: {
      objectKey: input.objectKey,
      masterSha256,
      masterByteLength: bytes.byteLength,
      probe,
    },
  };
}
