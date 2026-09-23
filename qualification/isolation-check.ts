export {};
/**
 * Isolation check for the qualification branch. PlanetScale Postgres branches
 * share a hostname and are addressed by the role username's `.<branch id>`
 * suffix, so a client can reach the branch only with a username carrying that
 * suffix. This fails if any Hyperdrive origin in the account, or any database
 * URL in the environment it runs under, carries it. Prints suffixes only.
 */
const branchId = process.argv[2];
const requireHyperdrive = process.argv.includes("--require-hyperdrive");
if (!branchId || !/^[a-z0-9]{12}$/u.test(branchId)) throw new Error("usage: isolation-check.ts <branch-id> [--require-hyperdrive]");
const suffix = (user: string) => (user.includes(".") ? user.split(".").slice(1).join(".") : "(none)");
const findings: { source: string; name: string; host: string; user_suffix: string; reaches_branch: boolean }[] = [];
for (const [name, value] of Object.entries(process.env)) {
  if (!value || !/^postgres(ql)?:\/\//u.test(value)) continue;
  const url = new URL(value);
  const s = suffix(decodeURIComponent(url.username));
  findings.push({ source: "environment", name, host: url.hostname, user_suffix: s, reaches_branch: s === branchId });
}
let hyperdriveChecked = false;
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (token) {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/08a4c22cf52e2ecae883e36f80a33f4a/hyperdrive/configs", { headers: { authorization: `Bearer ${token}` } });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: { id: string; name: string; origin?: { host?: string; user?: string } }[] };
  if (body.success) {
    hyperdriveChecked = true;
    for (const config of body.result ?? []) {
      const s = suffix(config.origin?.user ?? "");
      findings.push({ source: "hyperdrive", name: `${config.name} ${config.id.slice(0, 8)}`, host: config.origin?.host ?? "", user_suffix: s, reaches_branch: s === branchId });
    }
  }
}
const isolated = findings.every((f) => !f.reaches_branch) && (!requireHyperdrive || hyperdriveChecked);
console.log(JSON.stringify({ branch_id: branchId, hyperdrive_checked: hyperdriveChecked, findings, isolated }, null, 1));
if (!isolated) process.exitCode = 1;
