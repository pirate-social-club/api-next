import { decodeRewardOperationsPlan } from "./reward-operations-plan.ts";

export function rewardPlanFixture() {
  const descriptor = {
    id: "11111111-1111-1111-1111-111111111111",
    etag: "etag",
    message: `git:${"a".repeat(40)}`,
    runtime: { compatibility_date: "2026-08-01" },
    bindings: [
      { name: "MEGAPOT_REWARDS_ENABLED", type: "plain_text", text: "true" },
      { name: "SECRET", type: "secret_text" },
      { name: "CONTROL_PLANE", type: "hyperdrive", id: "b".repeat(32) },
    ],
  };
  return decodeRewardOperationsPlan({
    schemaVersion: 1,
    operationId: "fixture",
    authorizationReference: "review:fixture",
    environment: "staging",
    accountId: "a".repeat(32),
    target: "false",
    expectedRevision: "10",
    expiresAt: "2026-10-03T12:03:00Z",
    exclusionReference: "lease:fixture",
    journalNamespace: "/tmp/rewards-operator-fixture",
    databaseTarget: {
      organization: "fixture",
      databaseName: "fixture-db",
      databaseId: "database-id",
      branchName: "main",
      branchId: "branch-id",
      operator: {
        id: "operator-id",
        host: "operator.fixture",
        port: "5432",
        database: "postgres",
        login: "operator-login",
        sqlRole: "operator",
      },
      runtime: {
        http: {
          id: "runtime-id",
          host: "runtime.fixture",
          port: "5432",
          database: "postgres",
          login: "runtime-login",
          sqlRole: "runtime",
        },
        jobs: {
          id: "runtime-id",
          host: "runtime.fixture",
          port: "5432",
          database: "postgres",
          login: "runtime-login",
          sqlRole: "runtime",
        },
      },
    },
    workers: {
      http: {
        name: "pirate-http-worker-staging",
        hyperdriveId: "b".repeat(32),
        route: "settings-patch",
        baseline: structuredClone(descriptor),
      },
      jobs: {
        name: "pirate-jobs-worker-staging",
        hyperdriveId: "b".repeat(32),
        route: "settings-patch",
        baseline: structuredClone(descriptor),
      },
    },
  });
}
