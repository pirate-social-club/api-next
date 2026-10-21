import { expect, spyOn, test } from "bun:test";
import { ControlPlaneStatementFailed } from "../../../packages/application/src/ports.ts";
import { runVideoWorkflowStep } from "./video-workflow-diagnostics.ts";

const instanceId = `vaw-${"a".repeat(64)}`;

test.each(["render-publish", "decide-and-publish", "enrichment-run"])(
  "%s retains its safe database cause in the durable Error message and log",
  async (step) => {
    const failure = new ControlPlaneStatementFailed({
      label: "video-publication.post-insert",
      sqlState: "42501",
      constraint: null,
      outcomeCertainty: "aborted",
    });
    Object.assign(failure, {
      message: "private driver detail",
      query: "private SQL",
      values: ["private parameter"],
      connectionString: "postgres://private:credential@host/database",
    });
    const log = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      let retained: Error | undefined;
      try {
        await runVideoWorkflowStep(instanceId, step, async () => {
          throw failure;
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        retained = error as Error;
      }
      expect(retained).toBeDefined();
      // Workflow history retains only name/message, losing the original fields.
      const serialized = JSON.parse(
        JSON.stringify({ name: retained?.name, message: retained?.message }),
      );
      const diagnostic = {
        workflow_instance_id: instanceId,
        step,
        error_tag: "ControlPlaneStatementFailed",
        statement: "video-publication.post-insert",
        sql_state: "42501",
        constraint: null,
        outcome_certainty: "aborted",
      };
      expect(serialized.message).toBe(
        `video-workflow-database-failure:${JSON.stringify(diagnostic)}`,
      );
      expect(log).toHaveBeenCalledWith("video_workflow_database_failure", diagnostic);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      expect(serialized.message).not.toContain("private");
    } finally {
      log.mockRestore();
    }
  },
);

test("unknown SQLSTATE and uncertain outcome remain explicit without inventing a code", async () => {
  const failure = new ControlPlaneStatementFailed({
    label: "video-publication.submission-update",
    sqlState: null,
    constraint: "media_post_submissions_check",
    outcomeCertainty: "unknown",
  });
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(
      runVideoWorkflowStep(instanceId, "render-publish", async () => {
        throw failure;
      }),
    ).rejects.toThrow('"sql_state":null');
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      outcome_certainty: "unknown",
      constraint: "media_post_submissions_check",
    });
  } finally {
    log.mockRestore();
  }
});

test.each([
  new Error("ordinary failure"),
  {
    _tag: "ControlPlaneStatementFailed",
    label: "SQL with private values",
    sqlState: "42501",
    constraint: null,
    outcomeCertainty: "aborted",
  },
])("preserves unrecognized failures without expanding their content", async (failure) => {
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await expect(
      runVideoWorkflowStep(instanceId, "render-publish", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("returns successful step output unchanged", async () => {
  const value = { status: "published" };
  expect(await runVideoWorkflowStep(instanceId, "render-publish", async () => value)).toBe(value);
});
