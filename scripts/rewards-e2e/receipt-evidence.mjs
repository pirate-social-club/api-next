const hash = /^0x[0-9a-f]{64}$/i;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const results = new Set([
  "not_found",
  "provisional",
  "receipt_candidate",
  "invalid_response",
  "provider_failure",
]);

/** Keep public identifiers only; never persist an entire tail envelope or log object. */
export function receiptEvents(envelope) {
  if (!envelope || !Array.isArray(envelope.logs)) throw new Error("Invalid receipt tail envelope");
  const events = [];
  for (const log of envelope.logs) {
    if (!Array.isArray(log.message)) throw new Error("Invalid receipt tail log");
    for (const message of log.message) {
      let event;
      try {
        event = typeof message === "string" ? JSON.parse(message) : message;
      } catch {
        if (typeof message === "string" && message.includes("megapot_receipt_read"))
          throw new Error("Unparseable receipt observation");
        continue;
      }
      if (event?.event !== "megapot_receipt_read") continue;
      if (
        event.job !== "megapot-rewards.cycle" ||
        event.environment !== "test" ||
        event.chainId !== 84532 ||
        !positive(event.clientReadSequence) ||
        !(event.transactionReadSequence === null || positive(event.transactionReadSequence)) ||
        !hash.test(event.requestedTransactionHash ?? "") ||
        !results.has(event.result) ||
        !Number.isFinite(Date.parse(event.observedAt)) ||
        typeof event.workerVersion?.id !== "string" ||
        !event.workerVersion.id ||
        typeof event.rpcClientId !== "string" ||
        !event.rpcClientId ||
        typeof event.attemptId !== "string" ||
        !event.attemptId ||
        typeof event.attestationId !== "string" ||
        !event.attestationId
      )
        throw new Error("Invalid isolated receipt observation");
      events.push({
        event: event.event,
        job: event.job,
        environment: event.environment,
        chainId: event.chainId,
        versionId: event.workerVersion.id,
        attemptId: event.attemptId,
        rpcClientId: event.rpcClientId,
        clientReadSequence: event.clientReadSequence,
        transactionReadSequence: event.transactionReadSequence,
        observedAt: event.observedAt,
        attestationId: event.attestationId,
        transactionHash: event.requestedTransactionHash.toLowerCase(),
        result: event.result,
      });
    }
  }
  return events;
}

/** First means the first read in a bounded jobs RPC client, not first-ever on chain. */
export function firstJobsReceiptRead(capture, expected) {
  if (
    capture.worker !== "pirate-jobs-worker-megapot-e2e-staging" ||
    capture.outcome !== "subscribed" ||
    capture.subscriptionGaps !== 0 ||
    capture.parseFailures !== 0 ||
    !Number.isFinite(Date.parse(capture.connectedAt)) ||
    !Number.isFinite(Date.parse(capture.expiresAt)) ||
    Date.parse(capture.expiresAt) <= Date.now()
  )
    throw new Error("Receipt capture is incomplete or expired");
  if (
    !hash.test(expected.transactionHash ?? "") ||
    !expected.effectId ||
    !expected.jobsVersionId ||
    !expected.attestationId
  )
    throw new Error("Receipt purchase identity is missing");
  const matches = capture.events.filter(
    (event) => event.transactionHash === expected.transactionHash.toLowerCase(),
  );
  if (
    matches.some(
      (event) =>
        event.versionId !== expected.jobsVersionId ||
        event.attestationId !== expected.attestationId ||
        Date.parse(event.observedAt) < Date.parse(capture.connectedAt),
    )
  )
    throw new Error("Receipt source changed or predates subscription");
  const first = matches.find((event) => event.transactionReadSequence === 1);
  if (!first) throw new Error("First jobs receipt read was not captured");
  return {
    source: "jobs-worker",
    versionId: first.versionId,
    effectId: expected.effectId,
    transactionHash: first.transactionHash,
    attempt: first.transactionReadSequence,
    observedAt: first.observedAt,
    rpcClientId: first.rpcClientId,
    clientReadSequence: first.clientReadSequence,
    result: first.result,
  };
}
