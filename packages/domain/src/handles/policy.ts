export function normalizeCommunityHandleLabel(desiredLabel: unknown): {
  labelNormalized: string;
  labelDisplay: string;
} {
  if (typeof desiredLabel !== "string") {
    throw new Error("invalid_desired_label");
  }
  const trimmed = desiredLabel.trim().toLowerCase();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const withoutSuffix = withoutAt.includes("@")
    ? withoutAt.slice(0, withoutAt.indexOf("@"))
    : withoutAt;

  const isAsciiLabel = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(withoutSuffix);
  const isPunycodeLabel = /^xn--[a-z0-9-]+$/u.test(withoutSuffix);
  if (!withoutSuffix || (!isAsciiLabel && !isPunycodeLabel)) {
    throw new Error("invalid_desired_label");
  }
  return { labelNormalized: withoutSuffix, labelDisplay: withoutSuffix };
}
