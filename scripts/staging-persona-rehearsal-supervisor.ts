import { Schema } from "effect";
import {
  providerDiagnosticEnvironment,
  resolveDiagnosticIntent,
} from "./staging-persona-diagnostic-mode.ts";

const Completion = Schema.Struct({
  event: Schema.Literal("staging_rehearsal_completed"),
  mode: Schema.Literals(["dry-run", "execute"]),
});

/** The child must both finish its governed procedure and exit successfully.
 * Exit zero alone did not establish completion in the r8 exercise. This
 * supervisor does not retry, infer harmlessness, or authorize another attempt.
 * It adds independent process evidence; it does not diagnose that old exit.
 */
export async function superviseRehearsalProcess(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
  mode: "dry-run" | "execute",
  options: {
    readonly timeoutMs: number;
    readonly report: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
  },
) {
  let timedOut = false;
  let completions = 0;
  let wrongMode = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  const read = async (stream: "stdout" | "stderr") => {
    const reader = child[stream].getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const line = (text: string) => {
      try {
        const record: unknown = JSON.parse(text);
        if (Schema.is(Completion)(record)) {
          completions += 1;
          if (record.mode !== mode) wrongMode = true;
        }
      } catch {
        // Diagnostic output is not completion evidence.
      }
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        options.report(stream, next.value);
        if (stream === "stderr") continue;
        pending += decoder.decode(next.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          line(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > 1_048_576) throw new Error("rehearsal_output_limit_exceeded");
      }
      if (stream === "stdout") line(pending + decoder.decode());
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [exitCode] = await Promise.all([child.exited, read("stdout"), read("stderr")]);
    if (timedOut) throw new Error("rehearsal_process_deadline_exceeded");
    if (exitCode !== 0) throw new Error("rehearsal_process_failed");
    if (completions !== 1 || wrongMode) throw new Error("rehearsal_completion_unproven");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

if (import.meta.main) {
  try {
    if (Bun.argv.length !== 4) throw new Error("rehearsal_mode_required");
    const intent = resolveDiagnosticIntent(Bun.argv[2], Bun.argv[3]);
    const child = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/staging-persona-provider-rehearsal.ts`,
        intent.mode,
        intent.flag,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: providerDiagnosticEnvironment(process.env, intent.diagnostic),
      },
    );
    await superviseRehearsalProcess(child, intent.mode === "--execute" ? "execute" : "dry-run", {
      timeoutMs: 2 * 60 * 60 * 1_000,
      report: (stream, bytes) => {
        process[stream].write(bytes);
      },
    });
  } catch (error) {
    const reason =
      error instanceof Error &&
      [
        "rehearsal_mode_required",
        "rehearsal_diagnostic_mode_required",
        "rehearsal_diagnostic_mode_invalid",
        "rehearsal_process_deadline_exceeded",
        "rehearsal_process_failed",
        "rehearsal_completion_unproven",
        "rehearsal_output_limit_exceeded",
      ].includes(error.message)
        ? error.message
        : "rehearsal_supervision_failed";
    console.error(JSON.stringify({ outcome: "failed", reason, automatic_retry: false }));
    process.exitCode = 1;
  }
}
