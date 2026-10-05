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
    browserApi(page, `/api/rewards/credits/${credit.credit_id}/claim`, { method: "POST" }),
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
