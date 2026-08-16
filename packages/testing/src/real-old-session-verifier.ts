import {
  mintPirateAccessToken,
  verifyPirateAccessToken,
} from "../../../vendor/old-api-0b44698b/services/api/src/lib/auth/pirate-session-token.ts";

export type RealOldVerificationResult =
  | { readonly ok: true; readonly value: { readonly scope: string; readonly userId: string } }
  | { readonly ok: false };

async function withClock<T>(nowSeconds: number, action: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowSeconds * 1_000;
  try {
    return await action();
  } finally {
    Date.now = originalNow;
  }
}

export async function mintWithRealOldApi(input: {
  readonly privateKeyPem: string;
  readonly userId: string;
  readonly scope?: string;
  readonly nowSeconds: number;
}): Promise<string> {
  return withClock(input.nowSeconds, () =>
    mintPirateAccessToken({
      env: {
        PIRATE_APP_JWT_PRIVATE_KEY: input.privateKeyPem,
      },
      userId: input.userId,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    }),
  );
}

export async function verifyWithRealOldApi(input: {
  readonly token: string;
  readonly publicKeyPem: string;
  readonly nowSeconds: number;
}): Promise<RealOldVerificationResult> {
  return withClock(input.nowSeconds, async () => {
    try {
      const value = await verifyPirateAccessToken({
        env: { PIRATE_APP_JWT_PUBLIC_KEY: input.publicKeyPem },
        token: input.token,
      });
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  });
}
