/** Fixture-only orchestration. No database or provider work runs on import. */
import { ControlPlaneDb, type ControlPlaneError } from "@pirate/application";
import { Effect, type Layer } from "effect";
import type { Client } from "pg";
import { makeNotificationsVideoAdmissionStore } from "./notifications-video-admission.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { actor, persona, seedVideoActors } from "./video-publication.pg-fixture.ts";

/** Complete every action before providing the layer releases its session.
 * Callers return results, never a cached database service or admission store. */
export function runVideoAdmissionFixture<A, E>(
  runtime: Layer.Layer<ControlPlaneDb, ControlPlaneError>,
  use: (store: ReturnType<typeof makeNotificationsVideoAdmissionStore>) => Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* ControlPlaneDb;
      return yield* use(makeNotificationsVideoAdmissionStore(db));
    }).pipe(Effect.provide(runtime)),
  );
}

/** The publication persona is additional, while moderation presents the active
 * first persona. Activate that account's actual first persona through the
 * maintained wallet/profile/handle protocol after the account has been created. */
export async function seedNotificationsVideoActors(admin: Client): Promise<void> {
  await seedVideoActors(admin);
  const first = await admin.query<{ persona_id: string }>(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
    [actor],
  );
  const firstId = first.rows[0]?.persona_id;
  if (first.rows.length !== 1 || !firstId || firstId === persona)
    throw new Error("Distinct actual first moderator persona required");
  await activatePendingPersonaFixtures(admin, [firstId]);
  const active = await admin.query<{ persona_id: string }>(
    "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona AND status='active'",
    [actor],
  );
  if (active.rows.length !== 1 || active.rows[0]?.persona_id !== firstId)
    throw new Error("Moderator first persona activation did not complete");
}
