import { createHash } from "node:crypto";
import { Schema } from "effect";
import { loadMegapotBaseSepoliaBootstrapManifest } from "./bootstrap-megapot-base-sepolia.ts";
import { assertGoldenAdoptedPool } from "./megapot-golden-adopted-pool.ts";
import { authHeaders, endpoint, type GoldenHttpOptions } from "./megapot-golden-http.ts";
import { withGoldenJournal } from "./megapot-golden-journal.ts";
import { runGoldenActivity } from "./megapot-golden-multi-activities.ts";
import {
  assertMultiParticipantPreflight,
  type MultiGoldenInput,
  MultiParticipantPreflight,
} from "./megapot-golden-multi-input.ts";
import { prepareGoldenPool } from "./megapot-golden-multi-pool.ts";
import { collectGoldenPreflight } from "./megapot-golden-preflight-v2.ts";
import {
  observeGoldenDrawing,
  recoverGoldenDrawing,
  verifyGoldenIdentity,
  withGoldenReadOnly,
} from "./megapot-golden-readonly.ts";
import { waitForGoldenSettlement } from "./megapot-golden-reconciliation.ts";

function credentials(key: string, environment: NodeJS.ProcessEnv): GoldenHttpOptions {
  const authorization = environment[`${key}_AUTHORIZATION`];
  const cookie = environment[`${key}_COOKIE`];
  const csrfToken = environment[`${key}_CSRF_TOKEN`];
  return {
    apiOrigin: "https://api-next-staging.pirate.sc",
    ...(authorization === undefined ? {} : { authorization }),
    ...(cookie === undefined ? {} : { cookie }),
    ...(csrfToken === undefined ? {} : { csrfToken }),
  };
}

const defaultDependencies = {
  now: Date.now,
  sleep: Bun.sleep,
  readArtifact: (path: string): Promise<unknown> => Bun.file(path).json(),
  readAudio: (path: string) => Bun.file(path).arrayBuffer(),
  read: withGoldenReadOnly,
  verifyIdentity: verifyGoldenIdentity,
  pool: prepareGoldenPool,
  activity: runGoldenActivity,
  observe: observeGoldenDrawing,
  recoverDrawing: recoverGoldenDrawing,
};

export async function collectMultiGoldenPreflight(
  input: MultiGoldenInput,
  participantKey: string,
  ceremonyReference?: string,
) {
  const participant = input.participants.find((p) => p.key === participantKey);
  const url = process.env.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const host = process.env.PIRATE_STAGING_POSTGRES_HOST;
  const database = process.env.PIRATE_STAGING_POSTGRES_DATABASE;
  if (process.env.API_NEXT_ENV !== "staging" || !participant || !url || !host || !database)
    throw new Error("Pinned staging preflight configuration required.");
  return await withGoldenReadOnly(url, host, database, (client) =>
    collectGoldenPreflight(
      client,
      input,
      participant,
      credentials(participant.credential_key, process.env),
      ceremonyReference,
    ),
  );
}

export async function runMultiGolden(
  input: MultiGoldenInput,
  options: {
    execute: boolean;
    reconcileOnly: boolean;
    journalPath?: string;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies: typeof defaultDependencies = defaultDependencies,
) {
  if (!options.execute)
    return {
      mode: "dry-run",
      chain_id: 84532,
      participants: input.participants.map((p) => ({
        key: p.key,
        activities: p.activities,
        expected_admission: p.expected_admission,
      })),
      expected_shares: input.participants.filter((p) => p.expected_admission === "eligible").length,
      authorization_supplied: input.authorization !== null,
      funding_mode: input.app_funded_pool ? "app-funded" : "runner-created",
      live_calls: 0,
    };
  const environment = options.environment ?? process.env;
  const authorization = input.authorization;
  if (environment.API_NEXT_ENV !== "staging" || !authorization || !options.journalPath)
    throw new Error("Staging authorization and journal required.");
  const now = dependencies.now();
  if (
    now < Date.parse(authorization.execution_starts_at) ||
    now >= Date.parse(authorization.reconciliation_deadline) ||
    (!options.reconcileOnly && now >= Date.parse(authorization.qualification_deadline))
  )
    throw new Error("Outside authorized run window.");
  const dbUrl = environment.CONTROL_PLANE_POSTGRES_RUNTIME_URL;
  const dbHost = environment.PIRATE_STAGING_POSTGRES_HOST;
  const dbName = environment.PIRATE_STAGING_POSTGRES_DATABASE;
  if (!dbUrl || !dbHost || !dbName)
    throw new Error("Explicit staging read-only database pins required.");
  const read = <A>(fn: Parameters<typeof withGoldenReadOnly<A>>[3]) =>
    dependencies.read(dbUrl, dbHost, dbName, fn);
  return await withGoldenJournal(options.journalPath, input, async (journal) => {
    if (!options.reconcileOnly) {
      if (journal.state.pending_activity)
        throw new Error(
          "Prior activity outcome is ambiguous; inspect journal and reconcile, never create another attempt.",
        );
      const sponsor = credentials("PIRATE_STAGING", environment);
      endpoint(sponsor.apiOrigin, "/");
      authHeaders(sponsor, true);
      // All artifacts, credentials and audio are checked before any write or provider request.
      const prepared = await Promise.all(
        input.participants.map(async (participant) => {
          const http = credentials(participant.credential_key, environment);
          authHeaders(http, true);
          const artifact = Schema.decodeUnknownSync(MultiParticipantPreflight, {
            onExcessProperty: "error",
          })(await dependencies.readArtifact(participant.preflight_path));
          assertMultiParticipantPreflight(artifact, input, participant, dependencies.now());
          let pcm16: ArrayBuffer | undefined;
          if (participant.karaoke_audio) {
            pcm16 = await dependencies.readAudio(participant.karaoke_audio.pcm_path);
            if (
              pcm16.byteLength !== participant.karaoke_audio.duration_ms * 32 ||
              createHash("sha256").update(new Uint8Array(pcm16)).digest("hex") !==
                participant.karaoke_audio.sha256
            )
              throw new Error("Reviewed vocal audio mismatch.");
          }
          await read((client) => dependencies.verifyIdentity(client, artifact));
          return { participant, http, artifact, pcm16 };
        }),
      );
      const requiredStudySubmissions = prepared.reduce(
        (count, entry) =>
          count +
          (entry.participant.activities.includes("study") &&
          !journal.state.completed_activities.includes(`${entry.participant.key}:study`)
            ? entry.artifact.study_exercise_count
            : 0),
        0,
      );
      if (
        journal.state.study_submissions + requiredStudySubmissions >
        authorization.max_study_submissions
      )
        throw new Error("Study submission cap cannot cover planned work.");
      if (dependencies.now() >= Date.parse(authorization.qualification_deadline))
        throw new Error("Qualification window ended during preflight.");
      if (input.app_funded_pool) {
        const manifest = await loadMegapotBaseSepoliaBootstrapManifest();
        await read((client) => assertGoldenAdoptedPool(client, input, manifest.usdc_address));
      }
      const pool = await dependencies.pool(input, sponsor, journal);
      if (pool.state !== "funded") return pool;
      for (const { participant, http, artifact, pcm16 } of prepared) {
        for (const activity of participant.activities) {
          const key = `${participant.key}:${activity}`;
          if (journal.state.completed_activities.includes(key)) continue;
          if (dependencies.now() >= Date.parse(authorization.qualification_deadline))
            throw new Error("Qualification window ended before activity.");
          assertMultiParticipantPreflight(artifact, input, participant, dependencies.now());
          await read((client) => dependencies.verifyIdentity(client, artifact));
          await journal.save({ ...journal.state, pending_activity: key });
          await dependencies.activity(input, participant, artifact, activity, http, journal, pcm16);
          await journal.save({
            ...journal.state,
            pending_activity: null,
            completed_activities: [...journal.state.completed_activities, key],
          });
        }
      }
    }
    const legId = journal.state.leg_id;
    if (options.reconcileOnly && legId && !journal.state.drawing_id) {
      const recovered = await read((client) => dependencies.recoverDrawing(client, input, legId));
      await journal.save({ ...journal.state, drawing_id: recovered });
    }
    const drawingId = journal.state.drawing_id;
    if (!legId || !drawingId) throw new Error("Journal has no drawing to reconcile.");
    const settlement = await waitForGoldenSettlement(
      input,
      { legId, drawingId },
      {
        observe: () => read((client) => dependencies.observe(client, legId, drawingId)),
        now: dependencies.now,
        sleep: dependencies.sleep,
      },
    );
    if (
      settlement.terminal &&
      (journal.state.pending_activity ||
        input.participants.some((p) =>
          p.activities.some((a) => !journal.state.completed_activities.includes(`${p.key}:${a}`)),
        ))
    ) {
      return {
        state: "activity_evidence_incomplete" as const,
        terminal: false as const,
        settlement,
      };
    }
    return settlement;
  });
}
