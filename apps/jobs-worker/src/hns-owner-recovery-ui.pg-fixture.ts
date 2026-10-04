import { hsdRegtestWallet } from "../../../packages/platform-cf/src/hns-regtest-node.pg-fixture.ts";
import type { ReadyImport } from "../../http-worker/src/hns-community-activation.pg-fixture.ts";

/** Optional cross-repository acceptance. Both products keep their own sources;
 * the Solid controls reach real API handlers over a loopback HTTP transport.
 * Authentication and DNS provisioning remain explicit fixture boundaries. */
export async function checkOwnerRecoveryUi(input: {
  ready: ReadyImport;
  request: (command: "start" | "poll", body: unknown) => Response | Promise<Response>;
  records: readonly unknown[];
  mine: (blocks: number) => Promise<void>;
}): Promise<void> {
  const solidRoot = process.env.HNS_REGTEST_SOLID_ROOT;
  if (!solidRoot) return;
  if (
    !solidRoot.startsWith("/") ||
    !(await Bun.file(
      `${solidRoot}/src/features/community/owner-settings/community-namespace-settings-controller.test.tsx`,
    ).exists())
  )
    throw new Error("HNS UI acceptance requires an explicit Solid worktree");
  let published = false;
  const pollStatuses: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/__hns-fixture/polls") return Response.json(pollStatuses);
      if (path === "/__hns-fixture") return Response.json({ community_id: input.ready.community });
      if (path === "/__hns-fixture/publish" && request.method === "POST") {
        if (published) return new Response("Already published", { status: 409 });
        const challenge = (
          await input.ready.admin.query(
            "SELECT upstream_session_ref FROM community_route_revalidation_sessions WHERE community_id=$1 AND operation_mode='same_root_recovery' AND status='pending' ORDER BY created_at DESC LIMIT 1",
            [input.ready.community],
          )
        ).rows[0];
        if (!challenge) return new Response("No pending recovery", { status: 409 });
        published = true;
        await hsdRegtestWallet("sendupdate", [
          "harbor",
          {
            records: input.records.map((record) =>
              (record as { type: string }).type === "TXT"
                ? { type: "TXT", txt: [`pirate-verification=${challenge.upstream_session_ref}`] }
                : record,
            ),
          },
        ]);
        await input.mine(30);
        return Response.json({ published: true });
      }
      const prefix = `/api/communities/${input.ready.community}/`;
      if (!path.startsWith(prefix)) return new Response("Not found", { status: 404 });
      if (path.endsWith("/hns-root-imports") && request.method === "GET")
        return input.ready.call(path.slice(4));
      if (request.method === "POST" && request.headers.get("x-csrf-token") === "test-csrf") {
        if (path.endsWith("/ownership-recovery/start"))
          return input.request("start", await request.json());
        if (path.endsWith("/ownership-recovery/poll")) {
          const response = await input.request("poll", await request.json());
          pollStatuses.push(((await response.clone().json()) as { status: string }).status);
          return response;
        }
      }
      return new Response("Refused", { status: 403 });
    },
  });
  try {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        "test:app",
        "src/features/community/owner-settings/community-namespace-settings-controller.test.tsx",
        "--testNamePattern",
        "real API and regtest",
      ],
      {
        cwd: solidRoot,
        env: { ...process.env, HNS_RECOVERY_UI_FIXTURE: server.url.origin },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await Bun.write(
      "/tmp/hns-owner-recovery-real-ui.log",
      `${out + errors}\nActual poll responses: ${JSON.stringify(pollStatuses)}`,
    );
    if (code !== 0)
      throw new Error(
        `Real HNS recovery UI acceptance failed (${code}); see /tmp/hns-owner-recovery-real-ui.log`,
      );
    if (!published) throw new Error("UI acceptance did not publish its challenge");
    if (JSON.stringify(pollStatuses) !== JSON.stringify(["pending", "pending", "verified"]))
      throw new Error(`Real UI poll transitions differ: ${JSON.stringify(pollStatuses)}`);
  } finally {
    await server.stop(true);
  }
}
