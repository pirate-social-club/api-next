import {
  makeVerificationProviderRegistry,
  type VerificationProviderAdapter,
} from "@pirate/application/verification";
import { Effect } from "effect";
import { makeSelfPassProvider } from "./providers/self-pass.ts";
import {
  makeZkPassportProvider,
  makeZkPassportVerifierTransport,
  type ZkPassportVerifierTransport,
} from "./providers/zkpassport.ts";

const SELF_PASS_SESSION_TTL_MS = 15 * 60 * 1_000;

export interface PlatformVerificationProviderOptions {
  readonly self_pass?: Readonly<{
    readonly callback_origin: string;
    readonly app_name: string;
    readonly mock_passport: boolean;
  }>;
  /** ZKPassport remains absent unless every verifier credential is supplied. */
  readonly zkpassport?: Readonly<{
    readonly domain: string;
    readonly name: string;
    readonly logo?: string;
    readonly verifier_url?: string;
    readonly verifier_shared_secret?: string;
    readonly verifier?: ZkPassportVerifierTransport;
    readonly dev_mode?: boolean;
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
    ...(options.zkpassport === undefined ||
    options.zkpassport.domain.trim() === "" ||
    options.zkpassport.name.trim() === "" ||
    (options.zkpassport.verifier === undefined &&
      (options.zkpassport.verifier_url?.trim() === "" ||
        options.zkpassport.verifier_shared_secret?.trim() === "" ||
        options.zkpassport.verifier_url === undefined ||
        options.zkpassport.verifier_shared_secret === undefined))
      ? []
      : [
          makeZkPassportProvider({
            domain: options.zkpassport.domain,
            name: options.zkpassport.name,
            ...(options.zkpassport.logo === undefined ? {} : { logo: options.zkpassport.logo }),
            verifier:
              options.zkpassport.verifier ??
              makeZkPassportVerifierTransport({
                endpoint: options.zkpassport.verifier_url as string,
                shared_secret: options.zkpassport.verifier_shared_secret as string,
              }),
            ...(options.zkpassport.dev_mode === undefined
              ? {}
              : { dev_mode: options.zkpassport.dev_mode }),
            clock: {
              now: () => new Date().toISOString(),
              expiresAt: (now) =>
                new Date(Date.parse(now) + SELF_PASS_SESSION_TTL_MS).toISOString(),
            },
            identifiers: {
              next: (kind) =>
                kind === "session" ? crypto.randomUUID() : `${kind}-${crypto.randomUUID()}`,
            },
            digest: { digest: sha256 },
          }),
        ]),
  ];
  return makeVerificationProviderRegistry(
    providers,
    options.callback_credential_headers === undefined
      ? {}
      : { callbackCredentialHeaders: options.callback_credential_headers },
  );
}
