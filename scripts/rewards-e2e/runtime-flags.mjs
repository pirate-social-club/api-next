import { cloudflareApi } from "./cloudflare-api.mjs";
import { isolatedWorkers } from "./worker-plan.mjs";

const flagOf = (version) =>
  version.resources?.bindings?.find((binding) => binding.name === "MEGAPOT_REWARDS_ENABLED")?.text;
const descriptor = (version) =>
  JSON.stringify({
    script: version.resources?.script,
    runtime: version.resources?.script_runtime,
    bindings: version.resources?.bindings
      ?.filter((binding) => binding.name !== "MEGAPOT_REWARDS_ENABLED")
      .sort((a, b) => a.name.localeCompare(b.name)),
  });

export async function inspectIsolatedWorker(kind, api = cloudflareApi) {
  const name = isolatedWorkers[kind];
  if (!name) throw Error("Isolated Worker kind required");
  const base = `/workers/scripts/${name}`;
  const deployments = await api(`${base}/deployments`);
  const serving = deployments.deployments?.[0]?.versions;
  if (serving?.length !== 1 || serving[0].percentage !== 100)
    throw Error("Split or missing isolated deployment");
  const version = await api(`${base}/versions/${serving[0].version_id}`);
  const latest = (await api(`${base}/versions`)).items?.[0];
  if (!latest || latest.id !== version.id) throw Error("Isolated latest and serving differ");
  const bindings = version.resources?.bindings ?? [];
  const value = (name) => bindings.find((binding) => binding.name === name);
  if (
    value("API_NEXT_ENV")?.text !== "development" ||
    value("PIRATE_API_PUBLIC_ORIGIN")?.text !== "https://api-megapot-e2e-staging.pirate.sc" ||
    value("CONTROL_PLANE")?.id !== "04a1c805805d42d6bfc67ae7b005ec93" ||
    !["true", "false"].includes(flagOf(version))
  )
    throw Error("Isolated Worker resource identity differs");
  return version;
}

/** One settings mutation, with fresh latest==serving proof and no compensating enable. */
export async function setIsolatedRewardsFlag(
  kind,
  target,
  source,
  { api = cloudflareApi, sleep = Bun.sleep } = {},
) {
  if (!["true", "false"].includes(target) || !/^[a-f0-9]{40}$/.test(source ?? ""))
    throw Error("Isolated flag plan invalid");
  const before = await inspectIsolatedWorker(kind, api);
  if (!(before.annotations?.["workers/message"] ?? "").startsWith(`git:${source}`))
    throw Error("Isolated flag source differs");
  if (flagOf(before) === target)
    return { versionId: before.id, rewardsEnabled: target, changed: false };
  const name = isolatedWorkers[kind],
    base = `/workers/scripts/${name}`;
  const message = `git:${source} isolated-rewards:${target}:${Date.now()}`;
  const form = new FormData();
  form.set(
    "settings",
    JSON.stringify({
      annotations: { "workers/message": message },
      bindings: before.resources.bindings.map((binding) =>
        binding.name === "MEGAPOT_REWARDS_ENABLED"
          ? { name: binding.name, type: "plain_text", text: target }
          : { name: binding.name, type: "inherit", version_id: "latest" },
      ),
    }),
  );
  const fresh = await inspectIsolatedWorker(kind, api);
  if (fresh.id !== before.id || descriptor(fresh) !== descriptor(before))
    throw Error("Isolated Worker changed before mutation");
  await api(`${base}/settings`, { method: "PATCH", body: form });
  // PATCH deploys immediately. Poll only reads while the version list catches up.
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt) await sleep(5000);
    let after;
    try {
      after = await inspectIsolatedWorker(kind, api);
    } catch {
      continue;
    }
    if (after.annotations?.["workers/message"] !== message) continue;
    if (flagOf(after) !== target || descriptor(after) !== descriptor(before))
      throw Error("Isolated settings changed more than the flag");
    return { versionId: after.id, rewardsEnabled: target, changed: true };
  }
  throw Error("Isolated flag outcome uncertain; inspect serving state, do not replay");
}

export async function disableIsolatedRewards(source, options) {
  const results = await Promise.allSettled(
    ["http", "jobs"].map((kind) => setIsolatedRewardsFlag(kind, "false", source, options)),
  );
  return {
    flagsOff: results.every((result) => result.status === "fulfilled"),
    workers: results.map((result, index) => ({
      kind: ["http", "jobs"][index],
      ...(result.status === "fulfilled"
        ? result.value
        : { error: "Disable refused or uncertain; no enable attempted" }),
    })),
  };
}
