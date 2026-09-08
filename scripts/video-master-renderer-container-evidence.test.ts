import { describe, expect, it } from "bun:test";

import {
  containerRunArguments,
  decodeContainerFacts,
  validateContainerFacts,
} from "./video-master-renderer-container-evidence.ts";

describe("renderer container evidence policy", () => {
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

  it("accepts complete measured facts at the configured boundaries", () => {
    const facts = decodeContainerFacts(`ffmpeg_version=ffmpeg version 7.1.2
ffmpeg_package=7:7.1.2-0+deb13u1
cpu_max=100000 100000
memory_max=402653184
memory_peak=188743680
pids_max=128
concurrent_overlap=true
first_duration_ms=4000
second_duration_ms=4000
root_read_only=true`);
    expect(validateContainerFacts(facts)).toEqual(facts);
  });

  it("rejects evidence that did not receive the exact cgroup limits", () => {
    const facts = decodeContainerFacts(`ffmpeg_version=ffmpeg version 7.1.2
ffmpeg_package=7:7.1.2-0+deb13u1
cpu_max=max 100000
memory_max=402653184
memory_peak=188743680
pids_max=128
concurrent_overlap=true
first_duration_ms=4000
second_duration_ms=4000
root_read_only=true`);
    expect(() => validateContainerFacts(facts)).toThrow("cpu.max was not one CPU");
  });
});
