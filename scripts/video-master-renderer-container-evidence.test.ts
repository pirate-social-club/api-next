import { describe, expect, it } from "bun:test";

import {
  containerRunArguments,
  decodeConcurrentPidCeiling,
  decodeMemoryEnforcement,
  decodeOverlapFacts,
  decodePidEnforcement,
  decodeReadOnlyRootFacts,
  pinnedImageExpectation,
  type RetainedContainerState,
  validateCanonicalMasterFacts,
  validateConcurrentPidCeiling,
  validateImageIdentity,
  validateMemoryEnforcement,
  validateOverlapFacts,
  validatePidEnforcement,
  validateReadOnlyRootFacts,
} from "./video-master-renderer-container-evidence.ts";

const retained = (overrides: Partial<RetainedContainerState> = {}): RetainedContainerState => ({
  containerName: "test",
  exitCode: 0,
  oomKilled: false,
  logs: "",
  ...overrides,
});

const overlapEvidence = `samples=22
both_running_samples=21
both_busy_samples=20
overlap_ms=2270
first_exit=0
second_exit=0
memory_peak=134250496
pids_peak=88
cpu_max=100000 100000
memory_max=402653184
pids_max=128
first_duration_ms=4000
second_duration_ms=4000`;

const canonicalMasterFacts = {
  ffmpegVersion: "ffmpeg version 7.1.5-0+deb13u1",
  copiedPacketPayloadsMatch: true,
  sourcePacketManifestSha256: "576eb4d3",
  masterPacketManifestSha256: "576eb4d3",
  selectedVideoPackets: 56,
  effectiveDurationMs: 1866.666,
  masterVideoDurationMs: 1866.667,
  masterAudioPresentationDurationMs: 1866.667,
  decodedAudioSamplesPerChannel: 90_112,
  audioPresentationSamplesPerChannel: 89_600,
  audioPrimingSamplesPerChannel: 1_024,
  audioPaddingSamplesPerChannel: 512,
  targetPcmSamples: 89_600,
  paddedPcmSamples: 90_112,
  encodedAacPackets: 89,
  paddedAacFrames: 88,
  masterMovieTimescale: 48_000,
  masterSha256: "faa81423",
};

describe("renderer container isolation policy", () => {
  it("freezes isolation and cgroup arguments", () => {
    const arguments_ = containerRunArguments();
    expect(arguments_).toContain("--network=none");
    expect(arguments_).toContain("--read-only");
    expect(arguments_).toContain("--cpus=1");
    expect(arguments_).toContain("--memory=402653184");
    expect(arguments_).toContain("--memory-swap=402653184");
    expect(arguments_).toContain("--pids-limit=128");
    expect(arguments_).toContain("--tmpfs=/tmp:rw,noexec,nosuid,size=536870912");
  });
});

describe("renderer image identity", () => {
  const identity = {
    image_id: "sha256:0428b5768f59",
    ffmpeg_package: pinnedImageExpectation.ffmpegPackage,
    debian_snapshot: pinnedImageExpectation.debianSnapshot,
    ffmpeg_version: "ffmpeg version 7.1.5-0+deb13u1",
  };

  it("accepts an image built from the pinned inputs", () => {
    expect(validateImageIdentity(identity, pinnedImageExpectation)).toEqual(identity);
  });

  it("rejects a drifted package version rather than recording it as the pinned one", () => {
    expect(() =>
      validateImageIdentity(
        { ...identity, ffmpeg_package: "7:7.1.6-0+deb13u1" },
        pinnedImageExpectation,
      ),
    ).toThrow("did not equal the pinned");
  });

  it("rejects a drifted package snapshot", () => {
    expect(() =>
      validateImageIdentity(
        { ...identity, debian_snapshot: "20260101T000000Z" },
        pinnedImageExpectation,
      ),
    ).toThrow("snapshot");
  });

  it("rejects an identity that is not a content digest", () => {
    expect(() =>
      validateImageIdentity({ ...identity, image_id: "pinned" }, pinnedImageExpectation),
    ).toThrow("not a content digest");
  });
});

describe("canonical soundtrack replacement inside the image", () => {
  it("accepts an exact master", () => {
    expect(validateCanonicalMasterFacts(canonicalMasterFacts)).toEqual(canonicalMasterFacts);
  });

  it("rejects a master whose copied video packets changed", () => {
    expect(() =>
      validateCanonicalMasterFacts({
        ...canonicalMasterFacts,
        copiedPacketPayloadsMatch: false,
      }),
    ).toThrow("copied video packet payloads changed");
  });

  it("rejects a master whose selected packets diverged from the source", () => {
    expect(() =>
      validateCanonicalMasterFacts({
        ...canonicalMasterFacts,
        masterPacketManifestSha256: "other",
      }),
    ).toThrow("packet manifests diverged");
  });

  it("rejects soundtrack sample accounting that does not add up", () => {
    expect(() =>
      validateCanonicalMasterFacts({
        ...canonicalMasterFacts,
        decodedAudioSamplesPerChannel: 89_600,
      }),
    ).toThrow("did not equal the padded");
  });

  it("rejects an encoded packet count that is missing its priming frame", () => {
    expect(() =>
      validateCanonicalMasterFacts({ ...canonicalMasterFacts, encodedAacPackets: 88 }),
    ).toThrow("priming frame");
  });
});

describe("sustained concurrent encoding overlap", () => {
  it("accepts overlap measured across consecutive busy samples", () => {
    const facts = validateOverlapFacts(decodeOverlapFacts(overlapEvidence));
    expect(facts.both_busy_samples).toBe(20);
    expect(facts.overlap_ms).toBe(2_270);
    expect(facts.pids_peak).toBeLessThanOrEqual(facts.pids_max);
  });

  it("rejects processes that merely coexisted at one observation point", () => {
    expect(() =>
      validateOverlapFacts(
        decodeOverlapFacts(overlapEvidence.replace("both_busy_samples=20", "both_busy_samples=1")),
      ),
    ).toThrow("at least two consecutive busy samples");
  });

  it("rejects an overlap shorter than two sampling intervals", () => {
    expect(() =>
      validateOverlapFacts(
        decodeOverlapFacts(overlapEvidence.replace("overlap_ms=2270", "overlap_ms=90")),
      ),
    ).toThrow("was not sustained");
  });

  it("rejects a run in which either render failed", () => {
    expect(() =>
      validateOverlapFacts(
        decodeOverlapFacts(overlapEvidence.replace("second_exit=0", "second_exit=245")),
      ),
    ).toThrow("did not both succeed");
  });
});

describe("memory limit enforcement", () => {
  const evidence = `allocation_exit=137
memory_event_max=38
memory_event_oom=1
memory_event_oom_kill=1`;

  it("accepts an attributable out-of-memory kill", () => {
    const state = retained({ oomKilled: true });
    expect(validateMemoryEnforcement(decodeMemoryEnforcement(evidence), state)).toMatchObject({
      memory_event_oom_kill: 1,
    });
  });

  it("rejects a drill that never reached the ceiling", () => {
    expect(() =>
      validateMemoryEnforcement(
        decodeMemoryEnforcement(evidence.replace("memory_event_max=38", "memory_event_max=0")),
        retained({ oomKilled: true }),
      ),
    ).toThrow("never reached the memory ceiling");
  });

  it("rejects an allocation that ended for some reason other than a kill", () => {
    expect(() =>
      validateMemoryEnforcement(
        decodeMemoryEnforcement(evidence.replace("allocation_exit=137", "allocation_exit=1")),
        retained({ oomKilled: true }),
      ),
    ).toThrow("rather than by SIGKILL");
  });

  it("rejects evidence the retained container state does not corroborate", () => {
    expect(() => validateMemoryEnforcement(decodeMemoryEnforcement(evidence), retained())).toThrow(
      "did not record an out-of-memory kill",
    );
  });
});

describe("process limit enforcement", () => {
  const evidence = `pid_event_max=1
pids_peak=16
memory_event_oom_kill=0`;
  const forkFailure = retained({ logs: "/bin/sh: 0: Cannot fork\n" });

  it("accepts an attributable fork rejection", () => {
    expect(validatePidEnforcement(decodePidEnforcement(evidence), forkFailure, 16)).toMatchObject({
      pids_peak: 16,
    });
  });

  it("rejects a drill that never reached the ceiling", () => {
    expect(() =>
      validatePidEnforcement(
        decodePidEnforcement(evidence.replace("pid_event_max=1", "pid_event_max=0")),
        forkFailure,
        16,
      ),
    ).toThrow("never reached the PID ceiling");
  });

  it("refuses to attribute a failure that also ran out of memory", () => {
    expect(() =>
      validatePidEnforcement(
        decodePidEnforcement(
          evidence.replace("memory_event_oom_kill=0", "memory_event_oom_kill=1"),
        ),
        forkFailure,
        16,
      ),
    ).toThrow("not attributable");
  });

  it("refuses to attribute a failure with no retained diagnostic", () => {
    expect(() => validatePidEnforcement(decodePidEnforcement(evidence), retained(), 16)).toThrow(
      "no retained diagnostic",
    );
  });
});

describe("concurrent render at the historical 64 process ceiling", () => {
  const evidence = `first_exit=245
second_exit=0
pid_event_max=1
pids_peak=64
memory_event_oom_kill=0`;
  const threadFailure = retained({
    logs: "[aost#0:1/aac @ 0x0] pthread_create() failed: Resource temporarily unavailable\n",
  });

  it("attributes the rejection to thread creation rather than memory", () => {
    expect(
      validateConcurrentPidCeiling(decodeConcurrentPidCeiling(evidence), threadFailure, 64),
    ).toMatchObject({ pids_peak: 64 });
  });

  it("rejects a run in which the reduced ceiling rejected nothing", () => {
    expect(() =>
      validateConcurrentPidCeiling(
        decodeConcurrentPidCeiling(evidence.replace("first_exit=245", "first_exit=0")),
        threadFailure,
        64,
      ),
    ).toThrow("rejected nothing");
  });

  it("rejects a peak that never reached the configured ceiling", () => {
    expect(() =>
      validateConcurrentPidCeiling(
        decodeConcurrentPidCeiling(evidence.replace("pids_peak=64", "pids_peak=48")),
        threadFailure,
        64,
      ),
    ).toThrow("did not reach the configured ceiling");
  });

  it("refuses to attribute a failure with no FFmpeg thread diagnostic", () => {
    expect(() =>
      validateConcurrentPidCeiling(decodeConcurrentPidCeiling(evidence), retained(), 64),
    ).toThrow("no retained FFmpeg diagnostic");
  });
});

describe("read-only root attribution", () => {
  const evidence = `owned_directory_owner=bun
owned_directory_mode=700
process_user=bun
owned_directory_error=Read-only file system
root_error=Read-only file system
root_mount_options=ro,relatime`;

  it("accepts a denial the container user could otherwise have written", () => {
    expect(validateReadOnlyRootFacts(decodeReadOnlyRootFacts(evidence))).toMatchObject({
      root_mount_options: "ro,relatime",
    });
  });

  it("refuses to read a permission denial as a read-only mount", () => {
    expect(() =>
      validateReadOnlyRootFacts(
        decodeReadOnlyRootFacts(
          evidence.replace(
            "owned_directory_error=Read-only file system",
            "owned_directory_error=Permission denied",
          ),
        ),
      ),
    ).toThrow("rather than by read-only mount");
  });

  it("rejects a probe directory the container user does not own", () => {
    expect(() =>
      validateReadOnlyRootFacts(
        decodeReadOnlyRootFacts(
          evidence.replace("owned_directory_owner=bun", "owned_directory_owner=root"),
        ),
      ),
    ).toThrow("not owned by the container user");
  });

  it("rejects a probe directory whose owner has no write permission", () => {
    expect(() =>
      validateReadOnlyRootFacts(
        decodeReadOnlyRootFacts(
          evidence.replace("owned_directory_mode=700", "owned_directory_mode=500"),
        ),
      ),
    ).toThrow("does not grant its owner write permission");
  });

  it("rejects a root mount that is not actually read-only", () => {
    expect(() =>
      validateReadOnlyRootFacts(
        decodeReadOnlyRootFacts(
          evidence.replace("root_mount_options=ro,relatime", "root_mount_options=rw,relatime"),
        ),
      ),
    ).toThrow("not read-only");
  });
});
