import { expect, test } from "bun:test";
import { ControlPlaneStatementFailed } from "@pirate/application";
import { Effect } from "effect";
import { describeRehearsalFailure, StructuredRefusal } from "./staging-persona-rehearsal-failure";
import {
  providerRehearsalRefusal,
  sanitizeProviderRehearsalFailure,
} from "./staging-persona-rehearsal-inventory";

test("failure evidence excludes driver text, details and causes", () => {
  const error = Object.assign(
    new Error("postgres://private:secret@example.invalid/database", {
      cause: new Error("private-cause"),
    }),
    { code: "57014", detail: "private-detail" },
  );
  const result = describeRehearsalFailure(error);
  expect(result.sqlstate).toBe("57014");
  expect(result.message_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(describeRehearsalFailure({ code: "invalid-private" })).toEqual({
    sqlstate: null,
    message_sha256: null,
    reason: null,
    category: null,
  });
});

test("retains SQLSTATE from the actual Effect migration failure without its private label", async () => {
  let captured: unknown;
  try {
    await Effect.runPromise(
      Effect.fail(
        new ControlPlaneStatementFailed({
          label: "private-migration-label",
          sqlState: "55P03",
          constraint: null,
          outcomeCertainty: "unknown",
        }),
      ),
    );
  } catch (error) {
    captured = error;
  }
  const result = describeRehearsalFailure(captured);
  expect(result.sqlstate).toBe("55P03");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(describeRehearsalFailure({ sqlState: "invalid-private" }).sqlstate).toBeNull();
});

test("only allowlisted reasons are stated, with suffixes from finite stage sets", () => {
  const reason = (message: string) => describeRehearsalFailure(new Error(message)).reason;
  expect(reason("reset_forbidden_privilege_effective")).toBe("reset_forbidden_privilege_effective");
  expect(reason("provider_rehearsal_unproven:operation")).toBe(
    "provider_rehearsal_unproven:operation",
  );
  expect(reason("rehearsal_target_unbound:STAGING_REHEARSAL_BRANCH_ID")).toBe(
    "rehearsal_target_unbound:STAGING_REHEARSAL_BRANCH_ID",
  );
});

test("verified supervised-path refusals are stated exactly, not hidden behind the digest", () => {
  // The r10 attempt on 2026-09-13 failed with rehearsal_hyperdrive_exclusion_unproven
  // and reported a null reason; identifying it required a digest match. Each
  // string here is an exact literal in the supervised child or a direct module.
  for (const code of [
    "rehearsal_hyperdrive_exclusion_unproven",
    "rehearsal_backup_retention_unproven",
    "rehearsal_defaults_changed",
    "rehearsal_lock_observer_failed",
    "staging_provider_backup_unproven",
    "rehearsal_capacity_or_prepared_state_changed",
    "rehearsal_owned_session_missing",
    "rehearsal_session_input_unproven",
    "rehearsal_unexpected_session",
    "rehearsal_data_classes_unproven",
    "rehearsal_data_limit",
    "rehearsal_sequence_unproven",
  ])
    expect(reasonOf(code)).toBe(code);
});

test("a value appended to a verified refusal cannot ride out on the reason", () => {
  expect(reasonOf("rehearsal_hyperdrive_exclusion_unproven:synthetic_secret_value")).toBe(
    "rehearsal_hyperdrive_exclusion_unproven",
  );
  expect(reasonOf("staging_provider_backup_unproven:postgresql://user:pw@host/db")).toBe(
    "staging_provider_backup_unproven",
  );
  expect(reasonOf("rehearsal_data_limit:pw_leak")).toBe("rehearsal_data_limit");
});

test("an unlisted lowercase message is not a reason, however plausible it looks", () => {
  // Shape is not a boundary. These satisfy the identifier form and are still
  // withheld, because nothing states they are ours.
  for (const message of [
    "synthetic_secret_value",
    "postgres_rbuqf511oo6r",
    "some_internal_looking_reason",
    "reset_forbidden_privilege_effective_but_not_quite",
  ]) {
    const described = describeRehearsalFailure(new Error(message));
    expect(described.reason).toBeNull();
    expect(described.message_sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("a secret-shaped suffix is dropped while its known code survives", () => {
  // The code is ours and worth stating; the suffix may be anything at all, so
  // an unknown one never reaches output.
  expect(reasonOf("provider_rehearsal_unproven:synthetic_secret_value")).toBe(
    "provider_rehearsal_unproven",
  );
  expect(reasonOf("rehearsal_target_invalid:postgresql://user:pw@host/db")).toBe(
    "rehearsal_target_invalid",
  );
  expect(reasonOf("reset_forbidden_privilege_effective:role_named_after_a_customer")).toBe(
    "reset_forbidden_privilege_effective",
  );
  // An unlisted code with any suffix is withheld entirely.
  expect(reasonOf("unknown_code:target")).toBeNull();
});

function reasonOf(message: string) {
  return describeRehearsalFailure(new Error(message)).reason;
}

test("an internal reason is stated while driver text stays behind the digest", () => {
  // Our own literals are safe to name: an operator should not have to reproduce
  // a refusal to learn it was reset_forbidden_privilege_effective.
  expect(describeRehearsalFailure(new Error("reset_forbidden_privilege_effective")).reason).toBe(
    "reset_forbidden_privilege_effective",
  );
  expect(describeRehearsalFailure(new Error("provider_rehearsal_unproven:operation")).reason).toBe(
    "provider_rehearsal_unproven:operation",
  );
  // Driver text is not on the allowlist, so it stays behind the digest.
  for (const message of [
    'password authentication failed for user "pscale_api_mfw0y2wiyo1q"',
    "connection to server at 127.0.0.1, port 5432 failed",
    'relation "api_next.users" does not exist',
    "SELECT * FROM api_next.users WHERE token = 'secret'",
  ]) {
    const described = describeRehearsalFailure(new Error(message));
    expect(described.reason).toBeNull();
    expect(described.message_sha256).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("a preparation refusal survives the operator wrapper with its cause intact", () => {
  // The wrapper converts what it catches into its own phase failure. Without
  // preservation, every preparation refusal arrived as
  // provider_rehearsal_unproven:operation and the prerequisite that actually
  // failed was lost, which is what the production path did before this.
  for (const reason of [
    "reset_removal_refused:execution_unauthorized",
    "reset_removal_refused:backup_unlinked",
    "reset_removal_refused:data_digest_mismatch",
    "reset_removal_refused:operator_visibility",
    "reset_preparation_incomplete:forbidden_privileges",
    "reset_preparation_incomplete:operator_visibility",
    "reset_preparation_incomplete:runtime_identity",
  ])
    expect(sanitizeProviderRehearsalFailure(new Error(reason), "operation")).toBe(reason);
});

test("structured categories survive the wrapper and stay fixed labels", () => {
  const idle = Object.assign(new Error("read ECONNRESET from private-host"), {
    code: "ECONNRESET",
  });
  const idleDescribed = describeRehearsalFailure(providerRehearsalRefusal(idle, "operation"));
  expect(idleDescribed.reason).toBe("provider_rehearsal_unproven:operation");
  expect(idleDescribed.category).toBe("connection_exception");
  expect(JSON.stringify(idleDescribed)).not.toContain("private-host");

  const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  expect(describeRehearsalFailure(providerRehearsalRefusal(timeout, "operation"))).toMatchObject({
    category: "query_canceled",
    sqlstate: "57014",
  });

  const brokenPipe = Object.assign(new Error("write EPIPE at private-host"), { code: "EPIPE" });
  expect(describeRehearsalFailure(providerRehearsalRefusal(brokenPipe, "operation"))).toMatchObject(
    { category: "connection_exception", sqlstate: null },
  );

  const shutdown = Object.assign(new Error("terminating connection"), { code: "57P01" });
  expect(describeRehearsalFailure(providerRehearsalRefusal(shutdown, "operation")).category).toBe(
    "admin_shutdown",
  );

  const stage = new StructuredRefusal("reset_preparation_gate_failed:catalog", {
    category: "query_canceled",
    sqlstate: "57014",
  });
  const preserved = providerRehearsalRefusal(stage, "operation");
  expect(preserved).toBe(stage);
  expect(describeRehearsalFailure(preserved)).toMatchObject({
    reason: "reset_preparation_gate_failed:catalog",
    category: "query_canceled",
    sqlstate: "57014",
  });

  const ordinary = providerRehearsalRefusal(
    new Error("reset_forbidden_privilege_effective"),
    "operation",
  );
  expect(describeRehearsalFailure(ordinary)).toMatchObject({
    reason: "reset_forbidden_privilege_effective",
    category: null,
  });

  expect(
    describeRehearsalFailure(
      providerRehearsalRefusal(Object.assign(new Error("x"), { code: "XX999" }), "operation"),
    ).category,
  ).toBeNull();
  expect(describeRehearsalFailure(new Error("reset_preparation_gate_failed:denial")).reason).toBe(
    "reset_preparation_gate_failed:denial",
  );
});

test("the wrapper still flattens anything the allowlist does not recognise", () => {
  for (const message of [
    'password authentication failed for user "pscale_api_mfw0y2wiyo1q"',
    "an_unlisted_internal_reason",
    "",
  ])
    expect(sanitizeProviderRehearsalFailure(new Error(message), "operation")).toBe(
      "provider_rehearsal_unproven:operation",
    );
  // A known code with an unrecognised suffix keeps the code, never the suffix,
  // so a value that found its way into a suffix cannot ride out on the reason.
  expect(
    sanitizeProviderRehearsalFailure(new Error("provider_rehearsal_unproven:pw_leak"), "operation"),
  ).toBe("provider_rehearsal_unproven");
  expect(
    sanitizeProviderRehearsalFailure(
      new Error("reset_removal_refused:some_unlisted_suffix"),
      "operation",
    ),
  ).toBe("reset_removal_refused");
  // Non-errors carry no message and become the phase failure.
  expect(sanitizeProviderRehearsalFailure("a string", "runtime_identity")).toBe(
    "provider_rehearsal_unproven:runtime_identity",
  );
});
