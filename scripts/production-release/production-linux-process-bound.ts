import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileHash } from "./production-operation-evidence.ts";

/** Linux procfs identities bind a process instance, not just a reusable PID. */
export function linuxProcess(pid: number) {
  assert.equal(process.platform, "linux"); assert.ok(Number.isInteger(pid) && pid > 0);
  const parse = () => {
    const text = readFileSync("/proc/" + pid + "/stat", "utf8");
    const end = text.lastIndexOf(")"); assert.ok(end > 0);
    const parts = text.slice(end + 2).trim().split(/\s+/u);
    const [state, parent, group, session] = parts; const start = parts[19];
    assert.ok(state && parent && group && session && start && !["Z", "X", "x"].includes(state), "Bound process is no longer live");
    assert.match(start, /^\d+$/u);
    return { pid: Number(text.slice(0, text.indexOf(" "))), ppid: Number(parent), pgrp: Number(group),
      session: Number(session), start_ticks: start };
  };
  const before = parse(); assert.equal(before.pid, pid);
  const executable = realpathSync("/proc/" + pid + "/exe");
  const executable_sha256 = fileHash("/proc/" + pid + "/exe");
  const cmdline = readFileSync("/proc/" + pid + "/cmdline").toString("utf8").split("\0");
  assert.equal(cmdline.pop(), ""); assert.ok(cmdline.length > 0);
  const after = parse(); assert.deepEqual(after, before, "Bound process changed while observed");
  return { ...after, executable, executable_sha256, cmdline,
    boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}

export function checkBoundProcess(start: any, child: any, wrapperPath: string, review: any) {
  const own = linuxProcess(process.pid), timeout = linuxProcess(own.ppid), wrapper = linuxProcess(timeout.ppid);
  assert.deepEqual(wrapper, start.wrapper_identity, "Active wrapper identity or ancestry differs");
  assert.deepEqual(timeout, child.timeout_identity, "Actual timeout parent differs");
  assert.equal(own.ppid, timeout.pid); assert.equal(timeout.ppid, wrapper.pid);
  assert.equal(own.pgrp, timeout.pid); assert.equal(timeout.pgrp, timeout.pid, "GNU timeout must own its bounded process group");
  assert.equal(own.boot_id, timeout.boot_id); assert.equal(timeout.boot_id, wrapper.boot_id);
  assert.equal(own.executable, realpathSync(process.execPath));
  assert.equal(wrapper.executable, own.executable);
  assert.equal(wrapper.executable_sha256, review.execution_tools.bun_sha256);
  assert.equal(own.executable_sha256, review.execution_tools.bun_sha256);
  assert.equal(timeout.executable, realpathSync("/usr/bin/timeout"));
  assert.equal(timeout.executable_sha256, review.execution_tools.timeout_sha256);
  assert.deepEqual(timeout.cmdline, ["/usr/bin/timeout", "--signal=TERM", "--kill-after=10s", "180s", ...start.argv]);
  assert.deepEqual(own.cmdline, start.argv, "This process is not the wrapper's exact executor child");
  assert.deepEqual(wrapper.cmdline.slice(1), [wrapperPath, ...start.wrapper_arguments]);
  assert.equal(wrapper.cmdline[0], own.cmdline[0]);
}
