import { describe, expect, test } from "bun:test";
import {
  assertReviewedDrift,
  assertUnchangedBaseline,
  bindings,
  type CandidateBindings,
  compareServingBindings,
  parseServingDeployments,
  type ServingVersion,
} from "./worker-binding-drift.ts";
import { deploymentBinding } from "./worker-deployment-bindings.ts";

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw Error("missing fixture row");
  return item;
}

const now = new Date("2026-10-01T07:30:00Z");
const context = {
  source_sha: "a".repeat(40),
  environment: "staging",
  config_path: "apps/jobs-worker/wrangler.jsonc",
};
const runtime = {
  compatibility_date: "2026-08-01",
  compatibility_flags: ["nodejs_compat"],
  migration_tag: "v1",
  usage_model: "standard",
};
const pcm = (text: string) => ({
  name: "SONG_VIDEO_PCM_ADMISSION_ENABLED",
  type: "plain_text",
  text,
});
const secret = { name: "OPERATOR_SECRET", type: "secret_text" };
const native = { name: "MEDIA", type: "r2_bucket", bucket_name: "media-staging" };
const serving: readonly ServingVersion[] = [
  { version_id: "version-1", percentage: 100, runtime, bindings: [pcm("true"), secret, native] },
];
const candidate: CandidateBindings = {
  worker_name: "jobs-staging",
  runtime,
  bindings: [pcm("true"), native],
  required_secrets: [secret.name],
};
const compare = (desired = candidate, live = serving) =>
  compareServingBindings(context, desired, live, now);
const review = (receipt: ReturnType<typeof compare>) => ({
  ...receipt,
  reviewed_by_role: "release_coordinator",
  review_expires_at: "2026-10-01T07:45:00Z",
});

describe("serving binding drift", () => {
  test("reproduces the real serving PCM true / main false regression", () => {
    const receipt = compare({ ...candidate, bindings: [pcm("false"), native] });
    expect(receipt.changes).toHaveLength(1);
    expect(receipt.changes[0]?.name).toBe(pcm("").name);
    expect(() => assertReviewedDrift(receipt, undefined, now)).toThrow(
      "SONG_VIDEO_PCM_ADMISSION_ENABLED",
    );
  });
  test("unchanged effective bindings retain secret names without any secret values", () => {
    const receipt = compare();
    expect(receipt.changes).toEqual([]);
    expect(() => assertReviewedDrift(receipt, undefined, now)).not.toThrow();
    const exposed = [
      {
        ...first(serving),
        bindings: [pcm("true"), { ...secret, text: "sentinel-never-log" }, native],
      },
    ];
    const sanitized = compare(candidate, exposed);
    expect(sanitized).toEqual(receipt);
    expect(JSON.stringify(bindings(exposed[0]?.bindings))).not.toContain("sentinel-never-log");
    expect(JSON.stringify(sanitized)).not.toContain("sentinel-never-log");
  });
  test("requires an exact, dated reviewed change without broad waivers", () => {
    const receipt = compare({ ...candidate, bindings: [pcm("false"), native] });
    expect(() => assertReviewedDrift(receipt, review(receipt), now)).not.toThrow();
    for (const altered of [
      { ...review(receipt), source_sha: "b".repeat(40) },
      { ...review(receipt), changes: [] },
      { ...review(receipt), baseline_sha256: "b".repeat(64) },
      { ...review(receipt), environment: "production" },
      { ...review(receipt), allow_all: true },
      { ...review(receipt), review_expires_at: "2026-10-01T07:29:00Z" },
      { ...review(receipt), review_expires_at: "2026-10-01T08:01:00Z" },
    ])
      expect(() => assertReviewedDrift(receipt, altered, now)).toThrow();
  });
  test("detects additions, removals and native resource retargeting", () => {
    for (const desired of [
      { ...candidate, bindings: [pcm("true")] },
      { ...candidate, bindings: [pcm("true"), { ...native, bucket_name: "media-production" }] },
      {
        ...candidate,
        bindings: [...candidate.bindings, { name: "NEW", type: "hyperdrive", id: "new-resource" }],
      },
    ])
      expect(compare(desired).changes).toHaveLength(1);
  });
  test("checks every version with traffic and pins its allocation", () => {
    const traffic = [
      { ...first(serving), percentage: 80 },
      {
        ...first(serving),
        version_id: "version-2",
        percentage: 20,
        bindings: [pcm("false"), secret, native],
      },
    ];
    const receipt = compare(candidate, traffic);
    expect(receipt.changes[0]?.version_id).toBe("version-2");
    const changed = compare(
      candidate,
      traffic.map((row) => ({ ...row, percentage: 50 })),
    );
    expect(() => assertUnchangedBaseline(receipt, changed)).toThrow("changed before upload");
  });
  test("order and equivalent JSON bindings do not create drift", () => {
    const json = { name: "OPTIONS", type: "json", json: { z: 2, a: 1 } };
    const desired = { ...candidate, bindings: [...candidate.bindings, json] };
    const live = [
      {
        ...first(serving),
        bindings: [{ ...json, json: '{"a":1,"z":2}' }, ...first(serving).bindings].reverse(),
      },
    ];
    expect(compare(desired, live).changes).toEqual([]);
    expect(compare(desired, live).baseline_sha256).toBe(
      compare(desired, [{ ...first(live), bindings: [...first(live).bindings].reverse() }])
        .baseline_sha256,
    );
  });
  test("pins namespace IDs while comparing the exact upload selection", () => {
    const namespace = {
      name: "LOCK",
      type: "durable_object_namespace",
      class_name: "Lock",
      namespace_id: "namespace-one",
    };
    const desired = {
      ...candidate,
      bindings: [
        ...candidate.bindings,
        { name: "LOCK", type: "durable_object_namespace", class_name: "Lock" },
      ],
    };
    const live = [{ ...first(serving), bindings: [...first(serving).bindings, namespace] }];
    const receipt = compare(desired, live);
    expect(receipt.changes).toEqual([]);
    const changed = compare(desired, [
      {
        ...first(live),
        bindings: [...first(serving).bindings, { ...namespace, namespace_id: "namespace-two" }],
      },
    ]);
    expect(() => assertUnchangedBaseline(receipt, changed)).toThrow();
    const retarget = {
      ...desired,
      bindings: [
        ...candidate.bindings,
        { name: "LOCK", type: "durable_object_namespace", class_name: "OtherLock" },
      ],
    };
    expect(compare(retarget, live).changes).toHaveLength(1);
  });
  test("secret name and type changes cannot disappear through value redaction", () => {
    expect(() =>
      compare(candidate, [{ ...first(serving), bindings: [pcm("true"), native] }]),
    ).toThrow("required secret missing");
    expect(
      compare({
        ...candidate,
        bindings: [...candidate.bindings, { ...secret, type: "plain_text", text: "unexpected" }],
      }).changes,
    ).toHaveLength(1);
    expect(() =>
      compare(candidate, [
        { ...first(serving), percentage: 50 },
        {
          ...first(serving),
          version_id: "version-2",
          percentage: 50,
          bindings: [pcm("true"), native, { ...secret, name: "OTHER_SECRET" }],
        },
      ]),
    ).toThrow("ambiguous retained secret inventory");
  });
  test("missing baseline, malformed bindings and unsupported runtime refuse", () => {
    expect(() => compare(candidate, [])).toThrow();
    expect(() => bindings(undefined)).toThrow();
    expect(() => bindings([pcm("true"), pcm("false")])).toThrow("duplicate");
    expect(() => bindings([{ name: "UNKNOWN", type: "plain_text" }])).toThrow("incomplete");
    expect(() => compare({ ...candidate, runtime: { ...runtime, unknown: true } })).toThrow(
      "unsupported runtime",
    );
    expect(() =>
      compare({ ...candidate, runtime: { ...runtime, compatibility_flags: undefined } }),
    ).toThrow();
  });
  test("runtime drift cannot hide a similarly named binding", () => {
    const value = { name: "script_runtime", type: "plain_text", text: "first" };
    const desired = {
      ...candidate,
      runtime: { ...runtime, compatibility_date: "2026-09-01" },
      bindings: [...candidate.bindings, { ...value, text: "second" }],
    };
    const receipt = compare(desired, [
      { ...first(serving), bindings: [...first(serving).bindings, value] },
    ]);
    expect(receipt.changes.map((change) => change.kind)).toEqual(["binding", "runtime"]);
  });
  test("selects the newest serving deployment and rejects incomplete traffic", () => {
    const deployments = [
      { created_on: "2026-10-01T07:00:00Z", versions: [{ version_id: "old", percentage: 100 }] },
      {
        created_on: "2026-10-01T07:10:00Z",
        versions: [
          { version_id: "one", percentage: 60 },
          { version_id: "two", percentage: 40 },
          { version_id: "idle", percentage: 0 },
        ],
      },
    ];
    expect(parseServingDeployments(JSON.stringify(deployments.reverse()))).toEqual([
      { version_id: "one", percentage: 60 },
      { version_id: "two", percentage: 40 },
    ]);
    for (const invalid of [
      [],
      [{ created_on: "invalid", versions: [] }],
      [{ created_on: now.toISOString(), versions: [{ version_id: "one", percentage: 80 }] }],
    ])
      expect(() => parseServingDeployments(JSON.stringify(invalid))).toThrow();
  });
  test("deployment metadata uses remote resource IDs and refuses unresolved types", () => {
    expect(
      deploymentBinding("DATA", { type: "kv_namespace", id: "remote", preview_id: "preview" }),
    ).toEqual({ name: "DATA", type: "kv_namespace", namespace_id: "remote" });
    expect(
      deploymentBinding("DB", {
        type: "hyperdrive",
        id: "remote",
        localConnectionString: "sentinel-local-only",
      }),
    ).toEqual({ name: "DB", type: "hyperdrive", id: "remote" });
    expect(() => deploymentBinding("NEW", { type: "unknown" })).toThrow("unsupported");
    expect(() => deploymentBinding("R2", { type: "r2_bucket" })).toThrow("identity");
  });
});
