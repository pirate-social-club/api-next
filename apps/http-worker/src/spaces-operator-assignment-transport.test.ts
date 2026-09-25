import { describe, expect, test } from "bun:test";
import type { SpacesOperatorAssignmentStore } from "@pirate/platform-cf/spaces-operator-assignment-repository";
import { SpacesOperatorAssignmentRefused } from "@pirate/platform-cf/spaces-operator-assignment-repository";
import { makeSpacesOperatorAssignmentTransport } from "./spaces-operator-assignment-transport.ts";

const base = "http://worker.test/internal/spaces-operators/v1/assignments";
const candidate = {
  operator_assignment_id: `sassign_${"1".repeat(32)}`,
  generation: 1,
  network: "mainnet" as const,
  canonical_root: "yahoo",
  delegation_address: "bcs1p00rgyrzt0gmec52mu3w2un0xl6pzqyq9e8yc9t48fdk0cu3us8ys7rnkp7",
  replayed: false,
};
const body = JSON.stringify({
  idempotency_key: "prepare-1",
  operator_instance_id: "instance-yahoo",
  network: "mainnet",
  canonical_root: "yahoo",
  operator_wallet_reference: "wallet-yahoo",
  delegation_address: candidate.delegation_address,
});
const bearer = "pirate-spaces-operator-v1.test.secret";

function transport() {
  let calls = 0;
  const store: SpacesOperatorAssignmentStore = {
    prepare: async (token, request) => {
      calls += 1;
      if (token !== bearer) throw new SpacesOperatorAssignmentRefused("unauthorized");
      expect(request).toEqual(JSON.parse(body));
      return candidate;
    },
    readback: async (token, id, generation) => {
      if (token !== bearer) throw new SpacesOperatorAssignmentRefused("unauthorized");
      expect(id).toBe(candidate.operator_assignment_id);
      expect(generation).toBe(1);
      return { ...candidate, replayed: true };
    },
    list: async () => ({ candidate }),
    confirm: async () => candidate,
    reportCapability: async () => ({
      report_id: `sopsreport_${"2".repeat(32)}`,
      operator_assignment_id: candidate.operator_assignment_id,
      operator_assignment_generation: 1,
      observation_generation: 1,
      status: "observed",
      replayed: false,
    }),
    reportFunding: async () => ({
      report_id: `sopsreport_${"3".repeat(32)}`,
      operator_assignment_id: candidate.operator_assignment_id,
      operator_assignment_generation: 1,
      observation_generation: 1,
      status: "funded_v1",
      replayed: false,
    }),
    readbackReport: async () => ({
      report_id: `sopsreport_${"2".repeat(32)}`,
      operator_assignment_id: candidate.operator_assignment_id,
      operator_assignment_generation: 1,
      observation_generation: 1,
      status: "observed",
      replayed: true,
    }),
  };
  return { server: makeSpacesOperatorAssignmentTransport(store), calls: () => calls };
}

describe("Spaces operator assignment private transport", () => {
  test("requires its separate bearer and exact request bytes", async () => {
    const { server, calls } = transport();
    const request = (token: string | null, payload: string) =>
      new Request(`${base}/prepare`, {
        method: "POST",
        headers: token === null ? undefined : { authorization: `Bearer ${token}` },
        body: payload,
      });
    expect((await server.serve(request(null, body))).status).toBe(401);
    expect((await server.serve(request("pirate-spaces-registry-v1.fake.fake", body))).status).toBe(
      401,
    );
    expect((await server.serve(request(bearer, `${body} `))).status).toBe(400);
    const reordered = JSON.stringify({
      canonical_root: "yahoo",
      idempotency_key: "prepare-1",
      operator_instance_id: "instance-yahoo",
      network: "mainnet",
      operator_wallet_reference: "wallet-yahoo",
      delegation_address: candidate.delegation_address,
    });
    expect((await server.serve(request(bearer, reordered))).status).toBe(400);
    expect(
      (
        await server.serve(
          request(bearer, body.replace('"prepare-1"', '"prepare-1","idempotency_key":"prepare-1"')),
        )
      ).status,
    ).toBe(400);
    expect(calls()).toBe(1);
    const accepted = await server.serve(request(bearer, body));
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual(candidate);
  });

  test("reads a known generation without returning a wallet reference", async () => {
    const { server } = transport();
    const request = new Request(`${base}/${candidate.operator_assignment_id}?generation=1`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const response = await server.serve(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...candidate, replayed: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("report bodies are exact and have durable receipt routes", async () => {
    const { server } = transport();
    const capabilityBody = JSON.stringify({
      idempotency_key: "capability-1",
      operator_assignment_id: candidate.operator_assignment_id,
      operator_assignment_generation: 1,
      network: "mainnet",
      canonical_root: "yahoo",
      operator_wallet_reference: "wallet-yahoo",
      delegation_address: candidate.delegation_address,
      observed_at: "2026-09-25T12:00:00.000Z",
      can_operate: true,
    });
    const send = (body: string) =>
      server.serve(
        new Request(`${base}/capability`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body,
        }),
      );
    expect((await send(`${capabilityBody} `)).status).toBe(400);
    const accepted = await send(capabilityBody);
    expect(accepted.status).toBe(201);
    const receipt = (await accepted.json()) as { report_id: string };
    const readback = await server.serve(
      new Request(`${base}/capability/${receipt.report_id}`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    );
    expect(readback.status).toBe(200);
    expect(((await readback.json()) as { replayed: boolean }).replayed).toBe(true);
  });
});
