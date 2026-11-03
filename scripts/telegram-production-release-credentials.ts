import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { safeToolEnvironment } from "./production-release/production-managed-environment.ts";
import { fileHash } from "./public-post-http-release-source.ts";
import {
  type TelegramFile,
  telegramFile,
  telegramJson,
} from "./telegram-production-release-admission.ts";
import {
  TELEGRAM_RELEASE as policy,
  requireTelegram,
} from "./telegram-production-release-policy.ts";

interface CredentialContract {
  readonly kind: "telegram-managed-create-only-contract-v1";
  readonly accepted: true;
  readonly reviewer_role: "independent_reviewer";
  readonly findings: readonly never[];
  readonly origin: "https://app.infisical.com";
  readonly profile: string;
  readonly organization: string;
  readonly cli: TelegramFile;
  readonly evidence: readonly TelegramFile[];
  readonly atomic_create_only: true;
  readonly duplicate_refuses_without_update: true;
  readonly approval_is_not_creation: true;
}
export interface TelegramSecretMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly operation: string | null;
}
type Json = Record<string, unknown>;
function object(input: unknown): Json {
  requireTelegram(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "credential-response-refused",
  );
  return input as Json;
}
export function credentialContract(reference: TelegramFile) {
  const c = telegramJson<CredentialContract>(reference);
  requireTelegram(
    c.kind === "telegram-managed-create-only-contract-v1" &&
      c.accepted === true &&
      c.reviewer_role === "independent_reviewer" &&
      c.findings.length === 0 &&
      c.origin === "https://app.infisical.com" &&
      c.profile.length > 0 &&
      c.organization.length > 0 &&
      c.atomic_create_only === true &&
      c.duplicate_refuses_without_update === true &&
      c.approval_is_not_creation === true &&
      c.evidence.length >= 3,
    "create-only-credential-contract-unresolved",
  );
  telegramFile(c.cli);
  for (const source of c.evidence) telegramFile(source);
  return c;
}
/** Whitelist only non-secret metadata. Raw API errors and secret response bodies never escape. */
export function telegramSecretMetadata(input: unknown): TelegramSecretMetadata {
  const row = object(input);
  requireTelegram(
    row.workspace === policy.vault.project &&
      row.environment === policy.vault.environment &&
      row.type === "shared" &&
      typeof row.id === "string" &&
      row.id.length > 0 &&
      typeof row.secretKey === "string" &&
      Number.isInteger(row.version) &&
      Number(row.version) > 0,
    "credential-metadata-refused",
  );
  const metadata = Array.isArray(row.secretMetadata) ? row.secretMetadata : [];
  const marker = metadata.map(object).filter((m) => m.key === "pirate_release_operation");
  requireTelegram(marker.length <= 1, "duplicate-credential-operation-marker");
  return {
    id: row.id,
    name: row.secretKey,
    version: Number(row.version),
    operation: typeof marker[0]?.value === "string" ? marker[0].value : null,
  };
}
export interface TelegramVaultIo {
  list(): Promise<readonly TelegramSecretMetadata[]>;
  create(value: string): Promise<unknown>;
}
export async function createTelegramWrappingKey(io: TelegramVaultIo, assertBound: () => void) {
  requireTelegram(
    !(await io.list()).some((r) => r.name === policy.vault.name),
    "unexpected-existing-wrapping-key",
  );
  const material = randomBytes(32);
  try {
    const value = JSON.stringify({
      version: 1,
      credential_keys: { [policy.vault.keyVersion]: material.toString("base64") },
    });
    assertBound();
    const response = object(await io.create(value));
    requireTelegram(
      response.approval === undefined && response.secret !== undefined,
      "credential-approval-or-creation-unresolved",
    );
    const created = telegramSecretMetadata(response.secret);
    requireTelegram(
      created.name === policy.vault.name && created.version === 1,
      "created-credential-identity-differs",
    );
    const current = (await io.list()).filter((r) => r.name === policy.vault.name);
    requireTelegram(
      current.length === 1 &&
        current[0]?.id === created.id &&
        current[0]?.version === 1 &&
        current[0]?.operation === policy.operation,
      "credential-create-readback-unresolved",
    );
    return created;
  } finally {
    material.fill(0);
  }
}
/** Existing managed login only. Never call login, change profile, or pass a token in argv. */
export function managedTelegramVault(reference: TelegramFile, assertBound: () => void) {
  const c = credentialContract(reference);
  requireTelegram(fileHash(c.cli.path) === c.cli.sha256, "managed-cli-changed");
  const command = (...args: string[]) => {
    assertBound();
    try {
      return execFileSync(c.cli.path, args, {
        cwd: policy.paths.tooling,
        env: {
          ...safeToolEnvironment(),
          INFISICAL_DISABLE_UPDATE_CHECK: "true",
          INFISICAL_TELEMETRY_ENABLED: "false",
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      throw Error("managed-vault-command-refused");
    }
  };
  const status = object(
    JSON.parse(command("login", "status", "--json", "--profile", c.profile, "--silent")),
  );
  requireTelegram(
    Array.isArray(status.sessions) && status.sessions.length === 1,
    "single-managed-user-session-required",
  );
  const session = object(status.sessions[0]);
  requireTelegram(
    session.principalType === "user" &&
      session.status === "authenticated" &&
      session.domain === c.origin &&
      session.profile === c.profile &&
      session.organization === c.organization &&
      object(session.verification).state === "verified" &&
      Number(object(session.token).exp) * 1000 > Date.now() + 300_000,
    "fresh-existing-managed-session-required",
  );
  const token = command("user", "get", "token", "--plain", "--silent", "--profile", c.profile);
  requireTelegram(token.split(".").length === 3, "managed-token-unavailable");
  const claims = object(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
  requireTelegram(
    Number(claims.exp) * 1000 > Date.now() + 200_000 && claims.organizationId === c.organization,
    "managed-token-scope-or-expiry-differs",
  );
  const query = (values = false) =>
    new URLSearchParams({
      projectId: policy.vault.project,
      environment: policy.vault.environment,
      secretPath: policy.vault.path,
      type: "shared",
      viewSecretValue: String(values),
      expandSecretReferences: "false",
      includeImports: "false",
    });
  const request = async (path: string, init?: RequestInit): Promise<Json> => {
    assertBound();
    try {
      const result = await fetch(`${c.origin}/api/v4/secrets${path}`, {
        ...init,
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      requireTelegram(result.status === 200, "vault-request-refused-or-unresolved");
      return object(await result.json());
    } catch {
      throw Error("vault-request-refused-or-unresolved");
    }
  };
  return {
    async list() {
      const result = await request(`?${query()}`);
      requireTelegram(
        Array.isArray(result.secrets) &&
          (result.imports === undefined ||
            (Array.isArray(result.imports) && result.imports.length === 0)) &&
          result.secrets.length < 1000,
        "vault-inventory-incomplete",
      );
      return result.secrets.map(telegramSecretMetadata);
    },
    create: (value: string) =>
      request(`/${policy.vault.name}`, {
        method: "POST",
        body: JSON.stringify({
          projectId: policy.vault.project,
          environment: policy.vault.environment,
          secretPath: policy.vault.path,
          secretValue: value,
          type: "shared",
          secretMetadata: [{ key: "pirate_release_operation", value: policy.operation }],
        }),
      }),
    async bindings(worker: "http" | "jobs") {
      const names =
        worker === "jobs" ? [policy.vault.name, policy.vault.transcription] : [policy.vault.name];
      const result: Record<string, string> = {};
      for (const name of names) {
        const row = object((await request(`/${name}?${query(true)}`)).secret);
        const metadata = telegramSecretMetadata(row);
        requireTelegram(
          metadata.name === name &&
            typeof row.secretValue === "string" &&
            row.secretValue.length > 0,
          "runtime-secret-unavailable",
        );
        if (name === policy.vault.name) {
          requireTelegram(
            metadata.version === 1 && metadata.operation === policy.operation,
            "runtime-wrapping-key-identity-changed",
          );
          const compact = object(JSON.parse(row.secretValue)),
            keys = object(compact.credential_keys);
          requireTelegram(
            compact.version === 1 &&
              Object.keys(keys).join() === policy.vault.keyVersion &&
              typeof keys.v1 === "string" &&
              Buffer.from(keys.v1, "base64").length === 32,
            "runtime-wrapping-key-format-refused",
          );
        }
        result[name] = row.secretValue;
      }
      return result;
    },
  };
}
