import { describe, expect, test } from "bun:test";
import type {
  DanceAttemptSessionAuthorityResolver,
  DanceAttemptStore,
  DanceAttemptUploadAuthority,
} from "@pirate/application/use-cases/dance/attempt-services";
import { makeProductionDanceAttemptServices } from "./dance-attempt-production-composition.ts";

const unavailable = async (): Promise<never> => {
  throw new Error("Dance persistence must not run during composition inspection");
};

const inertStore: DanceAttemptStore = {
  lookupAction: unavailable,
  create: unavailable,
  consent: unavailable,
  reserve: unavailable,
  finalize: unavailable,
  submit: unavailable,
  get: unavailable,
};

describe("Dance attempt production composition", () => {
  test("resolves both private authorities to null unless explicitly injected", () => {
    const production = makeProductionDanceAttemptServices(inertStore);
    expect(production.sessionAuthority).toBeNull();
    expect(production.uploadAuthority).toBeNull();
    expect("processor" in production).toBe(false);
    expect("queue" in production).toBe(false);
    expect("workflow" in production).toBe(false);

    const sessionAuthority: DanceAttemptSessionAuthorityResolver = { resolve: unavailable };
    const uploadAuthority: DanceAttemptUploadAuthority = {
      reserve: unavailable,
      seal: unavailable,
    };
    const review = makeProductionDanceAttemptServices(
      inertStore,
      sessionAuthority,
      uploadAuthority,
    );
    expect(review.sessionAuthority).toBe(sessionAuthority);
    expect(review.uploadAuthority).toBe(uploadAuthority);
  });
});
