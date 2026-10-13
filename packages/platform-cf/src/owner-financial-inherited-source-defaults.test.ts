import { expect, test } from "bun:test";
import {
  ownerFinancialInheritedSourceDefaults as originals,
  readOwnerFinancialInheritedSourceDefaults,
} from "./owner-financial-inherited-source-defaults.ts";
import type { GuestStudyReadinessCandidate } from "./guest-study-readiness-profile.ts";
function candidate(): GuestStudyReadinessCandidate {
  return {
    source_head: "9f317d01e4c954d877de4d9265c14480b5b05008",
    native_phase: "owner_accounting_native_source_v1",
    ledger: [],
    inherited_source_default_signatures: originals.map((v) => v.signature),
    required_frames: originals.map((v) => ({
      signature: v.signature,
      body_sha256: v.body_sha256,
      definer: false,
      configuration: "none",
    })),
    native_function_bodies: originals.map((v) => ({
      name: v.signature.slice(0, v.signature.indexOf("(")),
      body_sha256: v.body_sha256,
      definer: false,
      configuration: "none",
    })),
    restricted_catalogue_probes: [],
    profiles: {
      learning: { columns: {}, functions: [] },
      publicRead: { columns: {}, functions: [] },
      cron: { columns: {}, functions: [] },
      observer: { columns: {}, functions: [] },
    },
  };
}
test("exact original37 accepts without redefining any purpose callback", () => {
  const source = candidate();
  expect(readOwnerFinancialInheritedSourceDefaults(source)).toEqual(
    originals.map((v) => v.signature),
  );
  expect(source.profiles.learning.functions).toEqual([]);
});
test("missing list, duplicate locator and private helper substituted into list refuse", () => {
  const original = candidate();
  const { inherited_source_default_signatures: _, ...missing } = original;
  expect(() => readOwnerFinancialInheritedSourceDefaults(missing)).toThrow();
  const signatures = originals.map((v) => v.signature),
    first = signatures[0];
  if (first === undefined) throw new Error("retained source required");
  expect(() =>
    readOwnerFinancialInheritedSourceDefaults({
      ...original,
      inherited_source_default_signatures: [first, ...signatures.slice(0, 36)],
    }),
  ).toThrow();
  expect(() =>
    readOwnerFinancialInheritedSourceDefaults({
      ...original,
      inherited_source_default_signatures: [
        "require_owner_accounting_ready_private_v1()",
        ...signatures.slice(1),
      ],
    }),
  ).toThrow();
});
test("a definer, pinned replacement or changed body cannot enter inheritedInvoker surface", () => {
  for (const alteration of [
    { definer: true },
    { configuration: "pinned" as const },
    { body_sha256: "0".repeat(64) },
  ]) {
    const source = candidate();
    expect(() =>
      readOwnerFinancialInheritedSourceDefaults({
        ...source,
        required_frames: source.required_frames.map((frame, i) =>
          i === 0 ? { ...frame, ...alteration } : frame,
        ),
      }),
    ).toThrow();
  }
});
test("native named body omission, duplicate overload/name, definer and changed body refuse", () => {
  const source = candidate(),
    first = source.native_function_bodies[0];
  if (first === undefined) throw new Error("actual original body required");
  expect(() =>
    readOwnerFinancialInheritedSourceDefaults({
      ...source,
      native_function_bodies: source.native_function_bodies.slice(1),
    }),
  ).toThrow();
  expect(() =>
    readOwnerFinancialInheritedSourceDefaults({
      ...source,
      native_function_bodies: [...source.native_function_bodies, first],
    }),
  ).toThrow();
  for (const alteration of [
    { definer: true },
    { configuration: "pinned" as const },
    { body_sha256: "0".repeat(64) },
  ])
    expect(() =>
      readOwnerFinancialInheritedSourceDefaults({
        ...source,
        native_function_bodies: source.native_function_bodies.map((body, i) =>
          i === 0 ? { ...body, ...alteration } : body,
        ),
      }),
    ).toThrow();
});
