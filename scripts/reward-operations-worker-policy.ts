import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";
import { RewardOperationsRefusal } from "./reward-operations-report.ts";

export const RewardVersionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u),
);
export const RewardWorkerDescriptorSchema = Schema.Struct({
  id: RewardVersionId,
  etag: Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/u)),
  message: Schema.String.check(Schema.isPattern(/^git:[0-9a-f]{40}(?: [ -~]{1,200})?$/u)),
  runtime: Schema.Record(Schema.String, Schema.Unknown),
  bindings: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});
export type RewardWorkerDescriptor = typeof RewardWorkerDescriptorSchema.Type;

export function canonicalRewardJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRewardJson).join(",")}]`;
  if (Predicate.isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalRewardJson(Reflect.get(value, key))}`)
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new RewardOperationsRefusal("identity-drift");
  return encoded;
}

export function rewardDescriptorDigest(value: unknown) {
  return createHash("sha256").update(canonicalRewardJson(value)).digest("hex");
}

export function decodeRewardWorkerDescriptor(value: unknown): RewardWorkerDescriptor {
  try {
    const descriptor = Schema.decodeUnknownSync(RewardWorkerDescriptorSchema, {
      onExcessProperty: "error",
    })(value);
    const names = new Set<string>();
    for (const binding of descriptor.bindings) {
      if (
        !Predicate.isString(binding.name) ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(binding.name) ||
        !Predicate.isString(binding.type) ||
        names.has(binding.name)
      )
        throw new RewardOperationsRefusal("identity-drift");
      names.add(binding.name);
    }
    rewardFlag(descriptor);
    canonicalRewardJson(descriptor);
    return descriptor;
  } catch {
    throw new RewardOperationsRefusal("identity-drift");
  }
}

export function rewardFlag(descriptor: RewardWorkerDescriptor): "true" | "false" {
  const binding = descriptor.bindings.find((item) => item.name === "MEGAPOT_REWARDS_ENABLED");
  if (binding?.type !== "plain_text" || (binding.text !== "true" && binding.text !== "false"))
    throw new RewardOperationsRefusal("identity-drift");
  return binding.text;
}

function normalizedBindings(descriptor: RewardWorkerDescriptor, target: "true" | "false") {
  return descriptor.bindings
    .map((binding) =>
      binding.name === "MEGAPOT_REWARDS_ENABLED" ? { ...binding, text: target } : binding,
    )
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function compareRewardWorkerDescriptor(
  baseline: RewardWorkerDescriptor,
  actual: RewardWorkerDescriptor,
  target = rewardFlag(baseline),
  exactIdentity = true,
) {
  if (
    (exactIdentity && (baseline.id !== actual.id || baseline.message !== actual.message)) ||
    rewardFlag(actual) !== target ||
    baseline.etag !== actual.etag ||
    baseline.message.slice(0, 44) !== actual.message.slice(0, 44) ||
    canonicalRewardJson(baseline.runtime) !== canonicalRewardJson(actual.runtime) ||
    canonicalRewardJson(normalizedBindings(baseline, target)) !==
      canonicalRewardJson(normalizedBindings(actual, target))
  )
    throw new RewardOperationsRefusal("identity-drift");
}

export function buildRewardFlagSettingsPatch(
  baseline: RewardWorkerDescriptor,
  target: "true" | "false",
  message: string,
) {
  return {
    annotations: { "workers/message": message },
    bindings: baseline.bindings.map((binding) =>
      binding.name === "MEGAPOT_REWARDS_ENABLED"
        ? { name: binding.name, type: "plain_text", text: target }
        : { name: binding.name, type: "inherit", version_id: "latest" },
    ),
  };
}

export function publicRewardWorkerState(descriptor: RewardWorkerDescriptor) {
  return {
    version: descriptor.id,
    flag: rewardFlag(descriptor),
    descriptorSha256: rewardDescriptorDigest(descriptor),
  };
}
