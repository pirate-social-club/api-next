import {
  makeVerificationProviderRegistry,
  type VerificationProviderAdapter,
} from "@pirate/application/verification";
import { Effect } from "effect";
import { makeSelfPassProvider } from "./providers/self-pass.ts";

const SELF_PASS_SESSION_TTL_MS = 15 * 60 * 1_000;

export interface PlatformVerificationProviderOptions {
  readonly self_pass?: Readonly<{
    readonly callback_origin: string;
    readonly app_name: string;
    readonly mock_passport: boolean;
  }>;
  readonly callback_credential_headers?: readonly string[];
}

function sha256(value: string) {
  return Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

function selfPassAdapter(config: NonNullable<PlatformVerificationProviderOptions["self_pass"]>) {
  return makeSelfPassProvider({
    ...config,
    clock: {
      now: () => new Date().toISOString(),
      expiresAt: (now) => new Date(Date.parse(now) + SELF_PASS_SESSION_TTL_MS).toISOString(),
    },
    identifiers: {
      next: (kind) => (kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`),
    },
    digest: { digest: sha256 },
  });
}

/**
 * The single production assembly point for provider adapters. Real providers
 * are added to this local list only after passing the shared conformance kit.
 */
export function makePlatformVerificationProviderRegistry(
  options: PlatformVerificationProviderOptions = {},
) {
  const providers: readonly VerificationProviderAdapter[] = [
    ...(options.self_pass === undefined ? [] : [selfPassAdapter(options.self_pass)]),
  ];
  return makeVerificationProviderRegistry(
    providers,
    options.callback_credential_headers === undefined
      ? {}
      : { callbackCredentialHeaders: options.callback_credential_headers },
  );
}
