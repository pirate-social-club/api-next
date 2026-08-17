import { expect, test } from "bun:test";
import { ProviderPresentation as ContractProviderPresentation } from "@pirate/contracts";
import { Schema } from "effect";
import { ProviderPresentation as ApplicationProviderPresentation } from "./adapter.ts";

test("application uses the canonical contract provider-presentation schema", () => {
  expect(ApplicationProviderPresentation).toBe(ContractProviderPresentation);
  expect(
    Schema.is(ApplicationProviderPresentation)({
      kind: "embedded_sdk",
      session_id: "session-1",
      protocol: "self-pass",
      version: "2",
      payload: { launch: true },
    }),
  ).toBe(true);
});
