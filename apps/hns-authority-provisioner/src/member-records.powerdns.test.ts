import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePowerDnsMemberWriter } from "./member-records.ts";
import {
  buildManagedRootRrsets,
  makePowerDnsRootInspector,
  makePowerDnsRootProvisioner,
} from "./powerdns.ts";

// Explicit opt-in: only this disposable, loopback-only authority is ever mutated.
const acceptance = process.env.HNS_MEMBER_POWERDNS_TEST === "1" ? test : test.skip;
const image =
  "powerdns/pdns-auth-51@sha256:f976e753a1de8ec62636203ecb12ae5fa3d1055601be167de53f1f673e0abe59";
const imageId = "sha256:f976e753a1de8ec62636203ecb12ae5fa3d1055601be167de53f1f673e0abe59";
type Rrset = {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
};

async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${stderr.slice(0, 1000)}`);
  return stdout.trim();
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("Missing local test port");
  return address.port;
}

acceptance(
  "real PowerDNS publishes, recovers, rotates and withdraws only its member records",
  async () => {
    expect(await command(["docker", "image", "inspect", "--format", "{{.Id}}", image])).toBe(
      imageId,
    );
    const directory = await mkdtemp(join(tmpdir(), "hns-member-powerdns-"));
    const apiPort = await freePort();
    const dnsPort = await freePort();
    expect(dnsPort).not.toBe(apiPort);
    let container: string | undefined;
    try {
      const configuration = join(directory, "pdns.conf");
      await writeFile(
        configuration,
        [
          "local-address=127.0.0.1",
          `local-port=${dnsPort}`,
          "api=yes",
          "api-key=local-member-test",
          "webserver=yes",
          "webserver-address=127.0.0.1",
          "webserver-allow-from=127.0.0.0/8",
          `webserver-port=${apiPort}`,
          "primary=yes",
          "version-string=anonymous",
          "",
        ].join("\n"),
      );
      const name = `hns-member-powerdns-${crypto.randomUUID()}`;
      container = await command([
        "docker",
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        "pirate.test=hns-member-publication",
        "--network",
        "host",
        "--cpus=1",
        "--memory=512m",
        "--memory-swap=512m",
        "--volume",
        `${configuration}:/etc/powerdns/pdns.d/member-test.conf:ro`,
        image,
      ]);
      if (!/^[a-f0-9]{64}$/u.test(container)) throw new Error("Invalid owned container identifier");
      const origin = `http://127.0.0.1:${apiPort}`;
      const api = async (path: string, init: RequestInit = {}) => {
        const response = await fetch(`${origin}/api/v1/servers/localhost${path}`, {
          ...init,
          signal: AbortSignal.timeout(3000),
          headers: { "x-api-key": "local-member-test", "content-type": "application/json" },
        });
        if (!response.ok) throw new Error(`Local PowerDNS HTTP ${response.status}`);
        return response;
      };
      for (let attempt = 0; ; attempt++) {
        try {
          await api("");
          break;
        } catch (error) {
          if (attempt >= 40) throw error;
          await Bun.sleep(250);
        }
      }
      expect(
        await command(["docker", "inspect", "--format", "{{.State.Running}}", container]),
      ).toBe("true");
      const config = {
        api_url: origin,
        api_key: "local-member-test",
        server_id: "localhost",
        soa_content: "ns1.pirate. hostmaster.pirate. 1 60 30 3600 60",
        axfr_tsig_key_name: "local-member-test.",
        gateway_ipv4: "192.0.2.10",
        shared_tlsa_association: `3 1 1 ${"ab".repeat(32)}`,
        gateway_deployment_reference: "local-member-test",
        gateway_certificate_spki_sha256: "ab".repeat(32),
        ttl_seconds: 60,
      };
      const root = {
        root_label: "example",
        challenge_txt_value: "pirate-verification=local-member-test",
      };
      await makePowerDnsRootProvisioner(config)({ ...root, current_records: [] });
      const read = async () =>
        ((await (await api("/zones/example.")).json()) as { rrsets: Rrset[] }).rrsets;
      const unrelated = {
        name: "operator.example.",
        type: "A",
        ttl: 60,
        records: [{ content: "192.0.2.99", disabled: false }],
      };
      await api("/zones/example.", {
        method: "PATCH",
        body: JSON.stringify({ rrsets: [{ ...unrelated, changetype: "REPLACE" }] }),
      });
      const target = {
        ...root,
        ...config,
        handle_label: "member",
        grant_id: "member-test-grant",
        publish: true,
      };
      let lost = false;
      const ambiguousWriter = makePowerDnsMemberWriter(config, async (url, init) => {
        const result = await fetch(url, init);
        if (init?.method === "PATCH" && !lost) {
          lost = true;
          throw new Error("simulated lost acknowledgement");
        }
        return result;
      });
      await expect(ambiguousWriter(target)).rejects.toThrow("simulated lost acknowledgement");
      const write = makePowerDnsMemberWriter(config);
      const publishedSerial = await write(target);
      expect(publishedSerial).toBeGreaterThan(0);
      expect(await write(target)).toBe(publishedSerial);
      expect(
        (await read()).find((row) => row.name === unrelated.name && row.type === "A"),
      ).toMatchObject(unrelated);

      const keys = await command([
        "dig",
        "+short",
        "+time=3",
        "+tries=1",
        "@127.0.0.1",
        "-p",
        String(dnsPort),
        "example",
        "DNSKEY",
      ]);
      const key = keys
        .split("\n")
        .map((line) => line.split(/\s+/u))
        .find((parts) => parts[0] === "257");
      if (!key?.[1] || !key[2] || key.length < 4)
        throw new Error("Missing local DNSSEC trust anchor");
      const anchor = join(directory, "trust-anchor.conf");
      await writeFile(
        anchor,
        `trust-anchors { "example." static-key ${key.slice(0, 3).join(" ")} "${key.slice(3).join("")}"; };\n`,
      );
      const validated = async (name: string, type: string, expected: string) => {
        const answer = await command([
          "delv",
          "-a",
          anchor,
          "+root=example",
          "-p",
          String(dnsPort),
          "@127.0.0.1",
          name,
          type,
        ]);
        expect(answer).toContain("fully validated");
        expect(answer.replaceAll(/\s/gu, "").toLowerCase()).toContain(
          expected.replaceAll(/\s/gu, "").toLowerCase(),
        );
      };
      await validated("member.example", "A", target.gateway_ipv4);
      await validated("_443._tcp.member.example", "TLSA", target.shared_tlsa_association);
      const rotated = {
        ...config,
        gateway_ipv4: "192.0.2.20",
        shared_tlsa_association: `3 1 1 ${"cd".repeat(32)}`,
        gateway_certificate_spki_sha256: "cd".repeat(32),
      };
      await makePowerDnsRootProvisioner(rotated)({ ...root, current_records: [] });
      await makePowerDnsRootInspector(rotated)(root);
      const rotatedTarget = { ...target, ...rotated };
      await write(rotatedTarget);
      await validated("member.example", "A", rotated.gateway_ipv4);
      await validated("_443._tcp.member.example", "TLSA", rotated.shared_tlsa_association);
      await expect(write({ ...rotatedTarget, grant_id: "different-grant" })).rejects.toThrow(
        "ownership conflict",
      );
      await expect(write({ ...rotatedTarget, handle_label: "operator" })).rejects.toThrow(
        "ownership conflict",
      );
      await write({ ...rotatedTarget, publish: false });
      await write({ ...rotatedTarget, publish: false });
      const after = await read();
      expect(
        after.filter((row) =>
          [
            "member.example.",
            "_443._tcp.member.example.",
            "_pirate-member.member.example.",
          ].includes(row.name),
        ),
      ).toEqual([]);
      expect(after.find((row) => row.name === unrelated.name && row.type === "A")).toMatchObject(
        unrelated,
      );
      for (const managed of buildManagedRootRrsets({ ...root, ...rotated })) {
        expect(
          after.find((row) => row.name === managed.name && row.type === managed.type),
        ).toMatchObject({
          name: managed.name,
          type: managed.type,
          ttl: managed.ttl,
          records: managed.records,
        });
      }
      await makePowerDnsRootInspector(rotated)(root);
    } finally {
      if (container && /^[a-f0-9]{64}$/u.test(container))
        await command(["docker", "rm", "--force", "--volumes", container]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120000,
);
