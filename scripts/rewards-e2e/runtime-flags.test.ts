import { expect, test } from "bun:test";
import { disableIsolatedRewards, setIsolatedRewardsFlag } from "./runtime-flags.mjs";

const source = "a".repeat(40);
function fixture(mode = "ok") {
  let version = {
    id: "initial",
    annotations: { "workers/message": `git:${source}` },
    resources: {
      script: { etag: "same", last_deployed_from: "wrangler" },
      script_runtime: { compatibility_date: "2026-08-01" },
      bindings: [
        { name: "API_NEXT_ENV", text: "development" },
        { name: "PIRATE_API_PUBLIC_ORIGIN", text: "https://api-megapot-e2e-staging.pirate.sc" },
        { name: "CONTROL_PLANE", id: "04a1c805805d42d6bfc67ae7b005ec93" },
        { name: "MEGAPOT_REWARDS_ENABLED", text: "false" },
      ],
    },
  };
  const mutations: string[] = [];
  const api = async (path: string, init?: { method?: string; body?: FormData }) => {
    if (init?.method === "PATCH") {
      mutations.push(path);
      if (mode === "uncertain") throw Error("Lost response");
      const data = JSON.parse(String(init.body?.get("settings")));
      version = structuredClone(version);
      version.id = "new";
      version.annotations = data.annotations;
      const flag = version.resources.bindings.find(
        (binding) => binding.name === "MEGAPOT_REWARDS_ENABLED",
      );
      if (!flag) throw Error("Fixture flag missing");
      flag.text = "true";
      // A settings-created version is always relabelled by the provider.
      version.resources.script.last_deployed_from = "api";
      if (mode === "drift") version.resources.script.etag = "different";
      return {};
    }
    if (path.endsWith("/deployments"))
      return { deployments: [{ versions: [{ version_id: version.id, percentage: 100 }] }] };
    if (path.endsWith("/versions")) return { items: [{ id: version.id }] };
    return structuredClone(version);
  };
  return { api, mutations };
}
test("an uncertain settings write is never retried", async () => {
  const f = fixture("uncertain");
  await expect(
    setIsolatedRewardsFlag("http", "true", source, { api: f.api, sleep: async () => {} }),
  ).rejects.toThrow("Lost response");
  expect(f.mutations.length).toBe(1);
});
test("the provider's source relabel alone does not refuse the flag change", async () => {
  const f = fixture();
  const result = await setIsolatedRewardsFlag("http", "true", source, {
    api: f.api,
    sleep: async () => {},
  });
  expect(result).toEqual({ versionId: "new", rewardsEnabled: "true", changed: true });
  expect(f.mutations.length).toBe(1);
});
test("a settings patch that changes code is refused", async () => {
  const f = fixture("drift");
  await expect(
    setIsolatedRewardsFlag("jobs", "true", source, { api: f.api, sleep: async () => {} }),
  ).rejects.toThrow("more than the flag");
  expect(f.mutations.length).toBe(1);
});
test("shared Worker names and wrong source refuse before mutation", async () => {
  const f = fixture();
  await expect(setIsolatedRewardsFlag("staging", "true", source, { api: f.api })).rejects.toThrow(
    "kind",
  );
  await expect(
    setIsolatedRewardsFlag("http", "true", "b".repeat(40), { api: f.api }),
  ).rejects.toThrow("source");
  expect(f.mutations.length).toBe(0);
});
test("closeout tries both Workers even when one read fails, and never enables", async () => {
  const paths: string[] = [];
  const f = fixture();
  const result = await disableIsolatedRewards(source, {
    api: async (path: string, init?: { method?: string; body?: FormData }) => {
      paths.push(path);
      if (path.includes("http-worker")) throw Error("Unreachable");
      return f.api(path, init);
    },
  });
  expect(result.flagsOff).toBe(false);
  expect(paths.some((path) => path.includes("jobs-worker"))).toBe(true);
  expect(f.mutations.length).toBe(0);
});
