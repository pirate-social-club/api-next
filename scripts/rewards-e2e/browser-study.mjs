import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isolatedOrigins } from "./worker-plan.mjs";

function assertOrigin(page) {
  if (new URL(page.url()).origin !== isolatedOrigins.web)
    throw new Error("Study browser origin differs");
}
async function sessionRead(page, path) {
  assertOrigin(page);
  return page.evaluate(async (resource) => {
    const response = await fetch(resource, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Study session read refused");
    return response.json();
  }, path);
}

/** Real recording and provider scoring; only each item's first presentation is allowed. */
export async function completeStudy(page, options) {
  const { communityId, sessionId, directory, microphonePath, deadline, firstCapture } = options;
  if (
    !/^community_[a-z0-9-]+$/.test(communityId ?? "") ||
    !/^study_v2_[a-z0-9]+$/.test(sessionId ?? "") ||
    typeof firstCapture !== "function" ||
    !Number.isFinite(deadline)
  )
    throw new Error("Study plan identity or bounded capture callback missing");
  const here = resolve(directory);
  if (resolve(microphonePath) !== `${here}/study-answer-microphone.wav`)
    throw new Error("Study microphone path must belong to its evidence directory");
  // The ffmpeg filter parses its path independently of shell escaping.
  if (!/^[a-zA-Z0-9_./-]+$/.test(here)) throw new Error("Study audio path is unsupported");
  const path = `/api/communities/${communityId}/study/v2/sessions/${sessionId}`;
  const log = (event) =>
    appendFileSync(
      `${here}/study-progress.jsonl`,
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  const seen = new Set();
  let answered = 0;
  try {
    const initial = await sessionRead(page, path);
    if (
      initial.session_id !== sessionId ||
      initial.status !== "active" ||
      initial.progress?.answered_exercise_count !== 0 ||
      initial.progress?.first_pass_correct !== 0
    )
      throw new Error("Study requires a fresh active session");
    for (let index = 0; index < 10; index++) {
      if (Date.now() >= deadline) throw new Error("Study deadline expired");
      const state = await sessionRead(page, path);
      const item = state.lesson?.current;
      if (
        state.status !== "active" ||
        !item ||
        item.is_reappearance ||
        seen.has(item.session_item_id)
      )
        throw new Error("Study repeated or missing presentation refused");
      const record = page.getByRole("button", { name: "Record", exact: true });
      await record.waitFor({ timeout: 20000 });
      const prompt = await page.locator("h2").innerText();
      if (!prompt.trim() || prompt.length > 1000) throw new Error("Study visible prompt differs");
      writeFileSync(`${here}/study-visible-prompt.txt`, prompt, { mode: 0o600 });
      execFileSync(
        "nice",
        [
          "-n",
          "19",
          "ffmpeg",
          "-nostdin",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `flite=textfile=${here}/study-visible-prompt.txt:voice=slt`,
          "-af",
          "apad=pad_dur=1",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          `${here}/study-next.wav`,
        ],
        { stdio: "pipe", timeout: 30000 },
      );
      const duration = Number(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            `${here}/study-next.wav`,
          ],
          { encoding: "utf8", timeout: 10000 },
        ),
      );
      if (!Number.isFinite(duration) || duration <= 0 || duration > 30)
        throw new Error("Study recording duration differs");
      renameSync(`${here}/study-next.wav`, resolve(microphonePath));
      const recheck = async () => {
        assertOrigin(page);
        if (Date.now() >= deadline) throw new Error("Study deadline expired");
        const current = await sessionRead(page, path);
        if (
          current.session_id !== sessionId ||
          current.status !== "active" ||
          current.progress?.answered_exercise_count !== index ||
          current.lesson?.current?.session_item_id !== item.session_item_id ||
          current.lesson.current.is_reappearance ||
          !(await record.isVisible()) ||
          !(await record.isEnabled())
        )
          throw new Error("Study presentation changed before recording");
      };
      const capture = async () => {
        await record.click();
        const disclosure = page.getByRole("dialog", { name: "Recording disclosure", exact: true });
        if (await disclosure.isVisible())
          await disclosure.getByRole("button", { name: "Continue to record", exact: true }).click();
      };
      await recheck();
      seen.add(item.session_item_id);
      log({
        event: "capture-prepared",
        sessionItemId: item.session_item_id,
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
        duration,
      });
      if (index === 0) await firstCapture(recheck, capture);
      else {
        await recheck();
        await capture();
      }
      await page.getByRole("button", { name: "Stop", exact: true }).waitFor({ timeout: 10000 });
      await page.waitForTimeout(Math.ceil(duration * 1000) + 200);
      assertOrigin(page);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].some((button) =>
            button.textContent?.includes("Checking"),
          ),
        null,
        { timeout: 45000 },
      );
      await page.waitForTimeout(1000);
      const after = await sessionRead(page, path);
      answered = index + 1;
      log({
        event: "provider-result",
        sessionItemId: item.session_item_id,
        status: after.status,
        answered: after.progress?.answered_exercise_count,
        scoreBps: after.progress?.score_bps,
      });
      if (after.progress?.answered_exercise_count !== answered)
        throw new Error("Study answer did not persist exactly once");
      if (after.status === "completed") break;
      const next = page.getByRole("button", { name: "Continue", exact: true });
      if (await next.isVisible()) await next.click();
    }
    const final = await sessionRead(page, path);
    if (
      final.status !== "completed" ||
      final.progress?.score_bps < 7000 ||
      !Number.isInteger(final.progress?.score_bps) ||
      final.progress.answered_exercise_count !== answered
    )
      throw new Error("Study did not complete and qualify");
    const report = {
      sessionId,
      status: "completed",
      scoreBps: final.progress.score_bps,
      answers: answered,
      firstPassCorrect: final.progress.first_pass_correct,
    };
    writeFileSync(`${here}/study-completion.json`, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return report;
  } catch {
    log({
      event: "stopped",
      answers: answered,
      reason: "First-pass Study failed; no answer replay",
    });
    throw new Error("Study first-pass execution stopped; inspect progress, never replay");
  }
}
