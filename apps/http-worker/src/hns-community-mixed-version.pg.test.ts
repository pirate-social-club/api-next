import { beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueHnsCommunityPublication } from "@pirate/application/namespace-ownership";
import { Effect } from "effect";
import type { Client } from "pg";
import { buildPreviousVerifierBundle } from "../../../scripts/hns-previous-verifier-bundle.ts";
import { handleRequest } from "../../hns-owner-verifier/src/index.ts";
import {
  prepareAcknowledgedImport,
  type VerifierHandler,
} from "./hns-community-activation.pg-fixture.ts";

/**
 * hns-txt-import-v1 across mixed releases. The previous verifier is the actual
 * build of api-next main before this change, rebuilt from git, not a stub of
 * it: repeated import polls against it, including after a rollback, must spend
 * none of the three completion attempts and must leave the import retryable.
 */

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres required");
const pgTest = url ? test : test.skip;
const BUDGET_MS = 240_000;
/** api-next main immediately before the separated-clocks change. */
const PREVIOUS_VERIFIER_REF =
  process.env.HNS_PREVIOUS_VERIFIER_REF ?? "6f029fbba9f4da4fd27ad1ca35e15f1209d534a5";

let previousVerifier: VerifierHandler | undefined;
let previousVerifierBuild = "";

beforeAll(async () => {
  if (url === undefined) return;
  const bundle =
    process.env.HNS_PREVIOUS_VERIFIER_BUNDLE ??
    join(await mkdtemp(join(tmpdir(), "hns-mixed-version-")), "previous-verifier.js");
  previousVerifierBuild =
    process.env.HNS_PREVIOUS_VERIFIER_BUNDLE === undefined
      ? await buildPreviousVerifierBundle(PREVIOUS_VERIFIER_REF, bundle)
      : `supplied ${bundle}`;
  const module = (await import(bundle)) as { readonly handleRequest?: VerifierHandler };
  if (typeof module.handleRequest !== "function") {
    throw new Error("previous verifier build does not export handleRequest");
  }
  previousVerifier = module.handleRequest;
}, 900_000);

type Recorded = { readonly path: string; readonly status: number };

/** Routes each request to the selected verifier build and records its answer. */
function switchable() {
  let selected: "current" | "previous" = "previous";
  const answers: Recorded[] = [];
  const verifier = (): VerifierHandler => async (request, env, options) => {
    const handler = selected === "previous" ? previousVerifier : handleRequest;
    if (handler === undefined) throw new Error("previous verifier was not built");
    const response = await handler(request, env, options);
    answers.push({ path: new URL(request.url).pathname, status: response.status });
    return response;
  };
  return {
    verifier,
    answers,
    select: (build: "current" | "previous") => {
      selected = build;
    },
  };
}

async function attempts(admin: Client) {
  return (
    await admin.query<{ state: string; attempt_number: number }>(
      "SELECT state, attempt_number FROM community_route_attachment_completion_attempts ORDER BY created_at",
    )
  ).rows;
}

async function poll(base: Awaited<ReturnType<typeof prepareAcknowledgedImport>>, times: number) {
  for (let index = 0; index < times; index++) {
    await base.admin.query(
      "UPDATE hns_community_publication_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'",
    );
    expect(
      await Effect.runPromise(
        continueHnsCommunityPublication(base.services, base.services.publicationQueue),
      ),
    ).toBe(true);
  }
}

async function expectRetryable(base: Awaited<ReturnType<typeof prepareAcknowledgedImport>>) {
  const job = await base.admin.query(
    "SELECT state, failure_code FROM hns_community_publication_jobs",
  );
  expect(job.rows).toEqual([{ state: "pending", failure_code: null }]);
  const session = (await (await base.call(base.sessionUrl)).json()) as Record<string, unknown>;
  expect(session).toMatchObject({ status: "awaiting_owner_update" });
  expect(session.failure_reason).toBeUndefined();
}

pgTest(
  "new HTTP against the previous verifier build spends no completion attempt",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const verifiers = switchable();
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      verifier: verifiers.verifier,
    });
    try {
      await poll(base, 6);
      const importAnswers = verifiers.answers.filter((answer) =>
        answer.path.endsWith("/import-poll"),
      );
      // The previous build has no import path at all.
      expect(importAnswers).toHaveLength(6);
      expect(new Set(importAnswers.map((answer) => answer.status))).toEqual(new Set([404]));
      // One reused reservation, recorded as not attempted; none counted.
      expect(await attempts(base.admin)).toEqual([{ state: "not_attempted", attempt_number: 1 }]);
      await expectRetryable(base);
      console.log(`previous verifier build: ${previousVerifierBuild}`);
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "a verifier rollback and roll-forward still spends at most the one real check",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const verifiers = switchable();
    verifiers.select("current");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      verifier: verifiers.verifier,
    });
    try {
      // The new verifier answers while the owner has not yet published.
      await poll(base, 2);
      expect(await attempts(base.admin)).toEqual([{ state: "released", attempt_number: 1 }]);
      // Rolled back to the previous build: every import poll is unsupported.
      verifiers.select("previous");
      await poll(base, 5);
      expect(await attempts(base.admin)).toEqual([{ state: "not_attempted", attempt_number: 1 }]);
      await expectRetryable(base);
      // Rolled forward after the owner published: the one check completes.
      verifiers.select("current");
      base.verifyOwnerPublication();
      await poll(base, 1);
      expect(await attempts(base.admin)).toEqual([{ state: "consumed", attempt_number: 1 }]);
      const session = (await (await base.call(base.sessionUrl)).json()) as { status: string };
      expect(session.status).toBe("observing");
      expect(
        verifiers.answers.filter((answer) => answer.status === 404).map((answer) => answer.path),
      ).toEqual(Array(5).fill("/internal/hns-owner/v1/import-poll"));
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "a verifier with the protocol disabled refuses as unsupported and spends no attempt",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const verifiers = switchable();
    verifiers.select("current");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      verifier: verifiers.verifier,
      importProtocol: { http: true, verifier: false },
    });
    try {
      await poll(base, 5);
      const importAnswers = verifiers.answers.filter((answer) =>
        answer.path.endsWith("/import-poll"),
      );
      expect(importAnswers).toHaveLength(5);
      expect(new Set(importAnswers.map((answer) => answer.status))).toEqual(new Set([501]));
      expect(await attempts(base.admin)).toEqual([{ state: "not_attempted", attempt_number: 1 }]);
      await expectRetryable(base);
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);

pgTest(
  "new HTTP whose provider entry lacks the capability reserves nothing and calls no verifier",
  async () => {
    if (url === undefined) throw new Error("Postgres required");
    const verifiers = switchable();
    verifiers.select("current");
    const base = await prepareAcknowledgedImport({
      connectionString: url,
      verifier: verifiers.verifier,
      importProtocol: { http: false, verifier: true },
    });
    try {
      const before = verifiers.answers.length;
      await poll(base, 5);
      expect(verifiers.answers.length).toBe(before);
      expect(await attempts(base.admin)).toEqual([]);
      await expectRetryable(base);
    } finally {
      await base.cleanup();
    }
  },
  BUDGET_MS,
);
