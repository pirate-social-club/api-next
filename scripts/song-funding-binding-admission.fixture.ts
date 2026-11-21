import { prepareSongFundingBindingAdmission } from "./song-funding-binding-admission.ts";
import type { CandidateBindings } from "./worker-binding-drift.ts";

const general = {
  scheme: "postgres",
  host: "branch.invalid",
  port: 5432,
  database: "postgres",
  user: "dance",
};
export const funding = { ...general, user: "funding" };
export function makeSongFundingAdmissionFixture(purpose: "http" | "jobs" = "http") {
  let cacheDisabled = true;
  let deployedOverride: CandidateBindings["bindings"] | undefined;
  let alias = false,
    drift = false,
    serving = "old";
  const checked: string[] = [];
  const candidate: { -readonly [K in keyof CandidateBindings]: CandidateBindings[K] } = {
    worker_name: "fixture",
    required_secrets: [],
    runtime: {},
    bindings: [
      { name: "CONTROL_PLANE", type: "hyperdrive", id: "general" },
      {
        name: purpose === "http" ? "SONG_FUNDING_COMMANDS" : "SONG_FUNDING_JOBS",
        type: "hyperdrive",
        id: "funding",
      },
      { name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text", text: "false" },
      { name: "SAFE_POOL_PILOT_ENABLED", type: "plain_text", text: "true" },
    ],
  };
  const dependencies = {
    candidate: async () => candidate,
    account: async () => "08a4c22cf52e2ecae883e36f80a33f4a",
    api: async (path: string): Promise<unknown> => {
      if (path.endsWith("/deployments"))
        return {
          deployments: [
            {
              created_on: "2026-10-26T10:00:00Z",
              versions: [{ version_id: drift ? crypto.randomUUID() : serving, percentage: 100 }],
            },
          ],
        };
      if (path.includes("/versions/"))
        return {
          id: serving,
          resources: {
            bindings:
              serving === "old"
                ? candidate.bindings.filter(
                    (b) =>
                      b.name !==
                      (purpose === "http" ? "SONG_FUNDING_COMMANDS" : "SONG_FUNDING_JOBS"),
                  )
                : (deployedOverride ?? candidate.bindings),
          },
        };
      return {
        id: path.split("/").at(-1),
        caching: { disabled: cacheDisabled },
        origin: path.endsWith("/general") || alias ? general : funding,
      };
    },
    identity: async (url: string) => {
      const user = new URL(url).username;
      return { role: user, session: user, database: "postgres" };
    },
    dancePermissions: async (url: string) => {
      checked.push("dance");
      return new URL(url).username;
    },
    fundingPermissions: async (url: string) => {
      checked.push("funding");
      return new URL(url).username;
    },
    environment: {
      CONTROL_PLANE_POSTGRES_RUNTIME_URL: "postgres://dance@branch.invalid/postgres",
      SONG_FUNDING_JOBS_POSTGRES_URL: "postgres://funding@branch.invalid/postgres",
      SONG_FUNDING_COMMANDS_POSTGRES_URL: "postgres://funding@branch.invalid/postgres",
    },
  };
  const run = () =>
    prepareSongFundingBindingAdmission(
      process.cwd(),
      purpose === "http" ? "apps/http-worker/wrangler.jsonc" : "apps/jobs-worker/wrangler.jsonc",
      "staging",
      "a".repeat(40),
      dependencies,
    );
  return {
    run,
    candidate,
    dependencies,
    checked,
    cache: () => {
      cacheDisabled = false;
    },
    alias: () => {
      alias = true;
    },
    drift: () => {
      drift = true;
    },
    deployed: (set: CandidateBindings["bindings"]) => {
      deployedOverride = set;
    },
    deploy: () => {
      serving = "new";
    },
  };
}
