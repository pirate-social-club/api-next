/**
 * Provenance for the executable old-api session verifier fixture.
 *
 * The verifier source is copied byte-for-byte from `git show` at the pinned
 * old-api commit. The adjacent error and environment files are only harness
 * seams; they are not presented as old-api source.
 */
export const OLD_API_SESSION_VENDOR = {
  repository: "https://github.com/pirate-social-club/api.git",
  sourceProject: "api",
  sourceCommit: "0b44698b0bdc16c057f9a8d33b61f8336d730abc",
  verifier: {
    sourcePath: "services/api/src/lib/auth/pirate-session-token.ts",
    sourceSha256: "5f5f31e895b4891978fb10b275b29c8c2420d18d018f3b19af92aa4553a07ea8",
    vendoredPath: "vendor/old-api-0b44698b/services/api/src/lib/auth/pirate-session-token.ts",
  },
  middleware: {
    sourcePath: "services/api/src/lib/auth-middleware.ts",
    sourceSha256: "18c1554b01a2c8445e680c8705998d47c2908341794eb5aba839a5e3b5fb22b7",
  },
  issuanceSites: [
    {
      name: "auth-session-exchange",
      sourcePath: "services/api/src/routes/auth.ts",
      sourceSha256: "dd7cdf247b8d7c873306c2f02ef660e5917e13a91ef818e91886012df6b86923",
      scopeInput: "default",
      claimShape: ["iss", "aud", "sub", "scope", "iat", "exp"],
    },
    {
      name: "telegram-mini-app-exchange",
      sourcePath: "services/api/src/lib/telegram/onboarding-service.ts",
      sourceSha256: "dc9b4533995e4ffe09e576c28f6a466861cdc919291e07047a839078662459c1",
      scopeInput: "default",
      claimShape: ["iss", "aud", "sub", "scope", "iat", "exp"],
    },
    {
      name: "bot-admin-token",
      sourcePath: "services/api/src/routes/bot-users.ts",
      sourceSha256: "7c8ef1fb615e583f6a80030ea4252c30b8c18bd0492b94be44c1f1999488ba21",
      scopeInput: "default",
      claimShape: ["iss", "aud", "sub", "scope", "iat", "exp"],
    },
    {
      name: "oauth-device-token",
      sourcePath: "services/api/src/lib/oauth/device-authorization-service.ts",
      sourceSha256: "6512e62b56db49b6f1dbee3415de7ce96442ff5c7006b26172d35d99b01140e8",
      scopeInput: "requested",
      claimShape: ["iss", "aud", "sub", "scope", "iat", "exp"],
    },
    {
      name: "telegram-community-join",
      sourcePath: "services/api/src/routes/telegram.ts",
      sourceSha256: "75ded3a6d7683bc23af6ed52afaf8dee693cf3f058a504693978cc61e25cd11e",
      scopeInput: "default",
      claimShape: ["iss", "aud", "sub", "scope", "iat", "exp"],
    },
  ],
} as const;
