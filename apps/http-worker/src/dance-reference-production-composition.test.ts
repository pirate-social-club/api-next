import { describe, expect, test } from "bun:test";
import type {
  DanceReferenceAuthoringAuthorityResolver,
  DanceReferenceStore,
} from "@pirate/application/use-cases/dance/reference-services";
import { makeProductionDanceReferenceServices } from "./dance-reference-production-composition.ts";

const unavailable = async (): Promise<never> => {
  throw new Error("Dance persistence must not run during composition inspection");
};

const inertStore: DanceReferenceStore = {
  lookupAction: unavailable,
  create: unavailable,
  getProcessing: unavailable,
  append: unavailable,
  disable: unavailable,
  retire: unavailable,
  listReady: unavailable,
  getRevision: unavailable,
  setPresentation: unavailable,
  clearPresentation: unavailable,
};

describe("Dance reference production composition", () => {
  test("resolves authoring authority to null unless explicitly injected", () => {
    const production = makeProductionDanceReferenceServices(inertStore);
    expect(production.authority).toBeNull();
    expect("processor" in production).toBe(false);

    const injected: DanceReferenceAuthoringAuthorityResolver = { resolve: unavailable };
    const reviewComposition = makeProductionDanceReferenceServices(inertStore, injected);
    expect(reviewComposition.authority).toBe(injected);
  });
});
