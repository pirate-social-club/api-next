import type { Client } from "pg";

export const providerFixtures = ["self.pass", "zkpassport"].map((provider_id) => ({
  provider_id,
  provider_configuration: { kind: "dynamic", reference: `test:${provider_id}`, version: "1" },
  method: "document",
  protocol_version: provider_id === "self.pass" ? "self-pass-v1" : "zkpassport-v2",
  scope: {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: provider_id,
    rp_scope: "test",
  },
  environment: "test",
}));

export async function insertCompletedNationalityEvidence(
  admin: Client,
  input: Readonly<{
    readonly suffix: string;
    readonly provider: "self.pass" | "zkpassport";
    readonly requirement: Readonly<{
      claim_id: "nationality.allowed";
      allowed_countries: readonly string[];
    }>;
    readonly expired?: boolean;
    readonly expirySeconds?: number;
    readonly startedSessionId?: string;
    readonly reuseBindingSuffix?: string;
  }>,
): Promise<void> {
  const provider = input.provider === "self.pass" ? providerFixtures[0] : providerFixtures[1];
  if (provider === undefined) throw new Error("provider fixture missing");
  const sessionId = input.startedSessionId ?? `proof-nationality-${input.suffix}`;
  const subjectId = `subject-nationality-${input.reuseBindingSuffix ?? input.suffix}`;
  const bindingEventId = `binding-event-nationality-${input.reuseBindingSuffix ?? input.suffix}`;
  const receiptId = `receipt-nationality-${input.suffix}`;
  const bindingId = `binding-nationality-${input.suffix}`;
  const assertionId = `assertion-nationality-${input.suffix}`;
  const receiptObservedAt = input.expired
    ? "clock_timestamp() - interval '2 hours'"
    : "clock_timestamp()";
  if (
    input.expirySeconds !== undefined &&
    (!Number.isSafeInteger(input.expirySeconds) || input.expirySeconds <= 0)
  )
    throw new Error("Invalid fixture expiry");
  const expiry =
    input.expirySeconds !== undefined
      ? `clock_timestamp() + make_interval(secs => ${input.expirySeconds})`
      : input.expired
        ? "clock_timestamp() - interval '1 minute'"
        : "clock_timestamp() + interval '1 day'";
  await admin.query("BEGIN");
  try {
    if (input.startedSessionId !== undefined) {
      const pending = await admin.query(
        "SELECT proof_session_id FROM proof_sessions WHERE proof_session_id=$1 AND actor_id='user-a' AND provider_id=$2 AND status='pending'",
        [sessionId, input.provider],
      );
      if (pending.rowCount !== 1) throw new Error("Expected real pending nationality session");
    } else
      await admin.query({
        text: `INSERT INTO proof_sessions (
             proof_session_id, actor_id, intent_id, request_hash, provider_id,
             provider_configuration_kind, provider_configuration_ref, provider_configuration_version,
             method, issuer, scope_kind, issuer_rp_scope, issuer_rp_action_scope,
             request_mode, protocol_version, environment, status, requested_requirements,
             requested_claim_ids, subject_binding_intent, started_at, expires_at,
             upstream_session_ref
           ) VALUES ($1, 'user-a', $2, repeat('a', 64), $3, 'dynamic', $4, '1',
                     'document', $3, 'issuer_rp_scope', 'test', NULL, 'dynamic', $5, 'test',
                     'pending', $6::jsonb, $7::jsonb, 'establish', clock_timestamp() - interval '2 hours',
                     clock_timestamp() + interval '1 day', $8)`,
        values: [
          sessionId,
          `nationality-intent-${input.suffix}`,
          provider.provider_id,
          provider.provider_configuration.reference,
          provider.protocol_version,
          JSON.stringify([input.requirement]),
          JSON.stringify(["nationality.allowed"]),
          `upstream-${input.suffix}`,
        ],
      });
    if (input.reuseBindingSuffix === undefined) {
      await admin.query({
        text: `INSERT INTO subject_keys (
             subject_key_id, issuer, method, scope_kind, issuer_rp_scope,
             issuer_rp_action_scope, subject_digest
           ) VALUES ($1, $2, 'document', 'issuer_rp_scope', 'test', NULL, repeat('1', 64))`,
        values: [subjectId, provider.provider_id],
      });
      await admin.query({
        text: `INSERT INTO subject_key_binding_events (
             binding_event_id, subject_key_id, binding_epoch, user_id, proof_session_id,
             binding_kind, idempotency_key, bound_at
           ) VALUES ($1, $2, 1, 'user-a', $3, 'initial', $4, clock_timestamp())`,
        values: [bindingEventId, subjectId, sessionId, `bind-${input.suffix}`],
      });
    }
    await admin.query({
      text: `INSERT INTO evidence_receipts (
             evidence_receipt_id, proof_session_id, user_id, provider_id, issuer, method,
             scope_kind, issuer_rp_scope, issuer_rp_action_scope, protocol_version, environment,
             evidence_kind, evidence_hash, receipt_metadata, observed_at, expires_at,
             provenance_kind, subject_key_id, subject_binding_event_id, subject_binding_epoch,
             provider_configuration_kind, provider_configuration_ref, provider_configuration_version
           ) VALUES ($1, $2, 'user-a', $3, $3, 'document', 'issuer_rp_scope', 'test', NULL, $4,
                     'test', 'document', repeat('c', 60) || substr(md5($1), 1, 4), '{}'::jsonb,
                     ${receiptObservedAt}, ${expiry},
                     'proof_session', $5, $6, 1, 'dynamic', $7, '1')`,
      values: [
        receiptId,
        sessionId,
        provider.provider_id,
        provider.protocol_version,
        subjectId,
        bindingEventId,
        provider.provider_configuration.reference,
      ],
    });
    await admin.query({
      text: `INSERT INTO assertion_bindings (
             binding_group_id, user_id, binding_mode, subject_key_id,
             subject_binding_event_id, subject_binding_epoch
           ) VALUES ($1, 'user-a', 'same_subject', $2, $3, 1)`,
      values: [bindingId, subjectId, bindingEventId],
    });
    await admin.query({
      text: `INSERT INTO assertions (
             assertion_id, binding_group_id, evidence_receipt_id, subject_key_id, user_id,
             claim_id, assertion_value, assurance, observed_at, expires_at
           ) VALUES ($1, $2, $3, $4, 'user-a', 'nationality.allowed',
                     '{"allowed": true}'::jsonb, 'document_zk', clock_timestamp(), NULL)`,
      values: [assertionId, bindingId, receiptId, subjectId],
    });
    await admin.query({
      text: `WITH terminal(value) AS (SELECT clock_timestamp())
             UPDATE proof_sessions
                SET status = 'completed',
                    completed_at = terminal.value,
                    completion_idempotency_key = $2,
                    completion_result_hash = repeat('b', 64),
                    terminal_at = terminal.value
               FROM terminal
              WHERE proof_session_id = $1`,
      values: [sessionId, `complete-${input.suffix}`],
    });
    await admin.query({
      text: `INSERT INTO proof_session_completion_events (
             completion_event_id, proof_session_id, actor_id, idempotency_key,
             terminal_status, result_hash, terminal_at
           ) SELECT $2, proof_session_id, actor_id, completion_idempotency_key,
                    status, completion_result_hash, terminal_at
               FROM proof_sessions
              WHERE proof_session_id = $1`,
      values: [sessionId, `completion-${input.suffix}`],
    });
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
