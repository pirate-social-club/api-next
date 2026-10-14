import { browserApi } from "./browser-api.mjs";
import { singleParticipantCredit } from "./participant-policy.mjs";
import { waitForEvidence } from "./run-evidence.mjs";
import { executeOnce } from "./single-use.mjs";

/** Only the isolated build simulates verification. Claim reservation and payout remain normal. */
export async function claimParticipantCredit(
  page,
  role,
  inventory,
  run,
  check,
  select = singleParticipantCredit,
) {
  const credit = select(inventory.credits, role);
  const once = (id, submit) =>
    executeOnce(run.directory, `${role}-${id}`, check, submit, {
      recheck: check,
      deadline: run.deadline,
    });
  // New owner Account participant uses the actual119 reader and immutable
  // original-persona branch. This rehearsal never auto-selects a Guest recipient.
  const ownerCredit =
    credit.identity_version === "owner_v1"
      ? await browserApi(page, `/api/users/me/rewards/owner-credits/v1/${credit.credit_id}`)
      : null;
  if (
    ownerCredit !== null &&
    (ownerCredit.object !== "owner_reward_credit_v1" ||
      ownerCredit.credit_id !== credit.credit_id ||
      ownerCredit.owner_id !== credit.participation_owner_id ||
      ownerCredit.recipient?.kind !== "account_owner" ||
      ownerCredit.recipient.original_persona_id !== credit.recipient_persona_id ||
      ownerCredit.recipient.binding?.persona_id !== credit.recipient_persona_id)
  )
    throw Error("Original Account participant recipient differs; Guest ceremony remains explicit");
  const intent = await once("claim-intent", () =>
    browserApi(page, "/api/rewards/claim-verification-intents", { method: "POST" }),
  );
  if (intent.provider_id !== "very.web") throw Error("Claim provider differs");
  const session = await once("verification-start", () =>
    browserApi(page, "/api/verification/sessions", {
      method: "POST",
      body: { intent_id: intent.intent_id, provider_id: "very.web" },
      statuses: [200, 201],
    }),
  );
  if (
    session.presentation?.payload?.simulated_verification !== "SIMULATED_REWARDS_CLAIM_VERIFICATION"
  )
    throw Error("Isolated verification label missing");
  const completed = await once("verification-complete", () =>
    browserApi(page, `/api/verification/sessions/${session.proof_session_id}/complete`, {
      method: "POST",
      body: { idempotency_key: `${run.runId}-${role}-verification`, payload: {} },
    }),
  );
  if (completed.status !== "completed") throw Error("Simulated verification incomplete");
  const claim = await once("claim-credit", () =>
    ownerCredit === null
      ? browserApi(page, `/api/rewards/credits/${credit.credit_id}/claim`, { method: "POST" })
      : browserApi(page, `/api/rewards/credits/${credit.credit_id}/owner-claims/v1`, {
          method: "POST",
          body: { idempotency_key: `${run.runId}-${role}-owner-claim`, selection_revision: null },
        }),
  );
  if (claim.outcome !== "accepted") throw Error("Participant claim not accepted");
  return waitForEvidence(
    `${role} confirmed payout`,
    run.deadline,
    () => run.inventory(),
    (result) => {
      const paid = select(result.credits, role);
      return paid.state === "sent" && paid.amount_atomic === paid.paid_atomic;
    },
    check,
  );
}
