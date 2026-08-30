import { describe, expect, test } from "bun:test";
import { type DataRegistrationRuntimeEnv, makeDataRegistrationComposition } from "./composition";

const base = {
  CONTROL_PLANE: { connectionString: "postgres://postgres:postgres@127.0.0.1:5432/postgres" },
  DATA_REGISTRATION_WORKFLOW: {
    get: async () => ({ status: async () => ({ status: "unknown" }) }),
    createBatch: async () => [],
  },
};

const privateKey = `0x${"0".repeat(63)}1`;
const signerAddress = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

const enabled = (environment: "staging" | "production"): DataRegistrationRuntimeEnv => ({
  ...base,
  API_NEXT_ENV: environment,
  DATA_REGISTRATION_ENABLED: "true",
  DATA_REGISTRATION_CHAIN_ID: "1315",
  DATA_REGISTRATION_RPC_URL: "https://aeneid.storyrpc.io",
  DATA_REGISTRATION_SIGNER_ADDRESS: signerAddress,
  DATA_REGISTRATION_SPG_NFT_CONTRACT: "0xc32A8a0FF3beDDDa58393d022aF433e78739FAbc",
  DATA_REGISTRATION_REQUIRED_CONFIRMATIONS: "3",
  DATA_REGISTRATION_PUBLIC_ORIGIN: "https://example.test",
  MEDIA_IMMUTABLE_ORIGINALS: {} as R2Bucket,
  FILEBASE_IPFS_TOKEN: "test-filebase-token",
});

describe("DATA registration composition", () => {
  test("does not require or read provider credentials while disabled", () => {
    const env = {
      ...base,
      API_NEXT_ENV: "production",
      DATA_REGISTRATION_ENABLED: "false",
      get DATA_REGISTRATION_STAGING_PRIVATE_KEY(): string {
        throw new Error("staging credential read while disabled");
      },
      get DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY(): string {
        throw new Error("production credential read while disabled");
      },
      get FILEBASE_IPFS_TOKEN(): string {
        throw new Error("provider credential read while disabled");
      },
    };
    expect(makeDataRegistrationComposition(env).workflow.options).toEqual({ enabled: false });
  });

  test("uses only the staging signer secret in staging", () => {
    const env = {
      ...enabled("staging"),
      DATA_REGISTRATION_STAGING_PRIVATE_KEY: privateKey,
      get DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY(): string {
        throw new Error("production signer secret read in staging");
      },
    };
    expect(makeDataRegistrationComposition(env).workflow.options).toEqual({ enabled: true });
  });

  test("uses only the production Aeneid signer secret in production", () => {
    const env = {
      ...enabled("production"),
      DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY: privateKey,
      get DATA_REGISTRATION_STAGING_PRIVATE_KEY(): string {
        throw new Error("staging signer secret read in production");
      },
    };
    expect(makeDataRegistrationComposition(env).workflow.options).toEqual({ enabled: true });
  });

  test("does not fall back to the staging secret in production", () => {
    expect(() =>
      makeDataRegistrationComposition({
        ...enabled("production"),
        DATA_REGISTRATION_STAGING_PRIVATE_KEY: privateKey,
      }),
    ).toThrow("DATA_REGISTRATION_PRODUCTION_AENEID_PRIVATE_KEY is required");
  });

  test("refuses to activate the reviewed direct-key adapter outside named Aeneid environments", () => {
    expect(() =>
      makeDataRegistrationComposition({
        ...base,
        API_NEXT_ENV: "development",
        DATA_REGISTRATION_ENABLED: "true",
      }),
    ).toThrow("Aeneid environment-only");
  });
});
