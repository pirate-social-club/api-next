import { ControlPlaneDb, type makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { makeSpacesOperatorAssignmentStore } from "@pirate/platform-cf/spaces-operator-assignment-repository";
import { makeSpacesOwnerProofStore } from "@pirate/platform-cf/spaces-owner-proof-repository";
import { makeControlPlaneSpacesRegistryStore } from "@pirate/platform-cf/spaces-registry-repository";
import { makeSpacesRootAuthorityObserver } from "@pirate/platform-cf/spaces-root-authority-observer";
import { Effect } from "effect";
import type { HttpWorkerOptions } from "./transport.ts";

export type SpacesRuntimeBindings = Readonly<{
  SPACES_RUNTIME_ENABLED?: string;
  SPACES_VERIFIER_ACCESS_CLIENT_ID?: string;
  SPACES_VERIFIER_ACCESS_CLIENT_SECRET?: string;
  SPACES_VERIFIER_BEARER_TOKEN?: string;
}>;

type SpacesOptions = Pick<
  HttpWorkerOptions,
  "spacesRegistry" | "spacesOwnerProof" | "spacesOperatorAssignments"
>;

/** The owner ceremony and private operator channel are staging-only until pilot acceptance. */
export function makeSpacesProductionComposition(
  bindings: SpacesRuntimeBindings,
  controlPlane: ReturnType<typeof makeHyperdriveControlPlaneLayer>,
  environment: "development" | "staging" | "production",
): SpacesOptions {
  if (bindings.SPACES_RUNTIME_ENABLED === undefined || bindings.SPACES_RUNTIME_ENABLED === "false")
    return {};
  if (bindings.SPACES_RUNTIME_ENABLED !== "true" || environment !== "staging")
    throw new Error("Spaces runtime configuration is invalid");
  const credentials = {
    accessClientId: bindings.SPACES_VERIFIER_ACCESS_CLIENT_ID ?? "",
    accessClientSecret: bindings.SPACES_VERIFIER_ACCESS_CLIENT_SECRET ?? "",
    bearerToken: bindings.SPACES_VERIFIER_BEARER_TOKEN ?? "",
  };
  const observer = makeSpacesRootAuthorityObserver(credentials);
  const withDb = <A>(run: (db: ControlPlaneDb["Service"]) => Promise<A>): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* ControlPlaneDb;
        return yield* Effect.tryPromise({ try: () => run(db), catch: (error) => error });
      }).pipe(Effect.provide(controlPlane)),
    );
  const ownerProof: NonNullable<SpacesOptions["spacesOwnerProof"]> = {
    start: (input) =>
      withDb((db) => makeSpacesOwnerProofStore({ db, observer, environment }).start(input)),
    poll: (input) =>
      withDb((db) => makeSpacesOwnerProofStore({ db, observer, environment }).poll(input)),
  };
  const assignments: NonNullable<SpacesOptions["spacesOperatorAssignments"]> = {
    prepare: (token, body) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).prepare(token, body),
      ),
    readback: (token, assignmentId, generation) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).readback(
          token,
          assignmentId,
          generation,
        ),
      ),
    list: (input) =>
      withDb((db) => makeSpacesOperatorAssignmentStore({ db, observer, environment }).list(input)),
    confirm: (input) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).confirm(input),
      ),
    reportCapability: (token, body) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).reportCapability(
          token,
          body,
        ),
      ),
    reportFunding: (token, body) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).reportFunding(token, body),
      ),
    readbackReport: (token, capability, reportId) =>
      withDb((db) =>
        makeSpacesOperatorAssignmentStore({ db, observer, environment }).readbackReport(
          token,
          capability,
          reportId,
        ),
      ),
  };
  return {
    spacesRegistry: {
      basePath: "/internal/spaces/registry/v1",
      store: makeControlPlaneSpacesRegistryStore(controlPlane),
      environment,
      pageCapacity: 1_000,
    },
    spacesOwnerProof: ownerProof,
    spacesOperatorAssignments: assignments,
  };
}
