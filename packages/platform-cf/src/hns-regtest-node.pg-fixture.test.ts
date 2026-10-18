import { describe, expect, test } from "bun:test";
import {
  createHsdRegtestFixture,
  hsdRegtestEndpointError,
  hsdRegtestGenesis,
  hsdRegtestIdentityError,
  probeHsdRegtestIdentity,
  probeHsdRegtestWallet,
  requireHsdRegtestChain,
  validateHnsRegtestTestContext,
} from "./hns-regtest-node.pg-fixture.ts";

describe("required HSD regtest identity", () => {
  test("chain-only preflight needs no database and refuses a mainnet node before wallet access", async () => {
    const methods: string[] = [];
    await expect(
      requireHsdRegtestChain(async (_url, method) => {
        methods.push(method);
        return method === "getblockchaininfo" ? { chain: "main" } : hsdRegtestGenesis;
      }),
    ).rejects.toThrow("HSD regtest required");
    expect(methods).toEqual(["getblockchaininfo", "getblockhash"]);
  });
  test("refuses non-loopback and non-HTTP fixture endpoints", () => {
    expect(hsdRegtestEndpointError("node", "http://127.0.0.1:14037/")).toBeNull();
    expect(hsdRegtestEndpointError("node", "https://127.0.0.1:14037/")).toContain(
      "http://127.0.0.1",
    );
    expect(hsdRegtestEndpointError("node", "http://regtest.example:14037/")).toContain(
      "http://127.0.0.1",
    );
  });

  test("accepts only the pinned regtest network and genesis", () => {
    expect(hsdRegtestIdentityError({ chain: "regtest", genesis: hsdRegtestGenesis })).toBeNull();
    expect(hsdRegtestIdentityError({ chain: "main", genesis: hsdRegtestGenesis })).toContain(
      "HSD regtest required",
    );
    expect(hsdRegtestIdentityError({ chain: "regtest", genesis: "wrong" })).toContain(
      "genesis mismatch",
    );
  });

  test("propagates an unavailable node instead of treating it as an identity", async () => {
    await expect(
      probeHsdRegtestIdentity(async () => {
        throw new Error("fixture unavailable");
      }),
    ).rejects.toThrow("fixture unavailable");
  });

  test("requires a reachable wallet with structured readiness data", async () => {
    await expect(probeHsdRegtestWallet(async () => null)).rejects.toThrow(
      "wallet returned malformed readiness data",
    );
    await expect(
      probeHsdRegtestWallet(async () => {
        throw new Error("wallet unavailable");
      }),
    ).rejects.toThrow("wallet unavailable");
    await expect(probeHsdRegtestWallet(async () => ({ id: "primary" }))).resolves.toBeUndefined();
  });
});

const postgres = "postgresql://socket-free.invalid/fixture";
function simulatedHsd(overrides: Readonly<Record<string, unknown>> = {}) {
  const calls: { url: string; method: string; authorization: string | null }[] = [];
  const transport = async (url: string, init: RequestInit) => {
    if (typeof init.body !== "string") throw new Error("RPC body missing");
    const body: unknown = JSON.parse(init.body);
    if (
      body === null ||
      typeof body !== "object" ||
      !("method" in body) ||
      typeof body.method !== "string"
    )
      throw new Error("RPC method missing");
    const headers = init.headers;
    if (
      headers === null ||
      typeof headers !== "object" ||
      !("authorization" in headers) ||
      typeof headers.authorization !== "string"
    )
      throw new Error("RPC authorization header missing");
    calls.push({
      url,
      method: body.method,
      authorization: headers.authorization,
    });
    const defaults: Readonly<Record<string, unknown>> = {
      getblockchaininfo: { chain: "regtest", blocks: 42 },
      getblockhash: hsdRegtestGenesis,
      getwalletinfo: { id: "primary" },
    };
    return new Response(
      JSON.stringify({
        result: body.method in overrides ? overrides[body.method] : defaults[body.method],
        error: null,
      }),
    );
  };
  return { calls, transport };
}

describe("explicit PG-only HNS test context", () => {
  test("default and configured reachable endpoints make zero transport or injected requests", async () => {
    for (const endpoints of [
      {},
      {
        HSD_REGTEST_NODE_URL: "http://127.0.0.1:24037/",
        HSD_REGTEST_WALLET_URL: "http://127.0.0.1:24039/",
      },
    ]) {
      const hsd = simulatedHsd();
      let requests = 0;
      const request = async () => {
        requests += 1;
        return {};
      };
      const f = createHsdRegtestFixture(
        {
          ...endpoints,
          CONTROL_PLANE_POSTGRES_TEST_URL: postgres,
          HNS_REGTEST_TEST_CONTEXT: "pg-only",
        },
        { fetch: hsd.transport },
      );
      expect(await f.hsdRegtestReachable()).toBe(false);
      for (const invoke of [
        () => f.hsdRegtestNode("generatetoaddress", [1, "unused"]),
        () => f.hsdRegtestWallet("sendopen", ["unused"]),
        () => f.hsdRegtestHeight(),
        () => f.probeHsdRegtestIdentity(),
        () => f.probeHsdRegtestWallet(),
        () => f.probeHsdRegtestIdentity(request),
        () => f.probeHsdRegtestWallet(request),
        () => f.requireHsdRegtest(request),
        () => f.requireHsdRegtestChain(request),
      ])
        await expect(invoke()).rejects.toThrow("disabled in pg-only");
      expect(hsd.calls).toEqual([]);
      expect(requests).toBe(0);
    }
  });
  test("unknown contexts and required-HNS conflicts fail before transport", () => {
    const hsd = simulatedHsd();
    expect(validateHnsRegtestTestContext({})).toBe("hns");
    expect(validateHnsRegtestTestContext({ HNS_REGTEST_TEST_CONTEXT: "hns" })).toBe("hns");
    for (const context of ["", "PG-only", "pg-only ", " hns", "unknown"]) {
      expect(() =>
        createHsdRegtestFixture({ HNS_REGTEST_TEST_CONTEXT: context }, { fetch: hsd.transport }),
      ).toThrow("must be hns or pg-only");
    }
    expect(() =>
      createHsdRegtestFixture(
        {
          HNS_REGTEST_TEST_CONTEXT: "pg-only",
          HNS_REGTEST_TEST_REQUIRED: "1",
          CONTROL_PLANE_POSTGRES_TEST_URL: postgres,
        },
        { fetch: hsd.transport },
      ),
    ).toThrow("conflicts");
    expect(hsd.calls).toEqual([]);
  });
  test("a context is fixed per factory and cannot be changed by later environment mutation", async () => {
    const environment = { HNS_REGTEST_TEST_CONTEXT: "pg-only" };
    const hsd = simulatedHsd();
    const f = createHsdRegtestFixture(environment, { fetch: hsd.transport });
    environment.HNS_REGTEST_TEST_CONTEXT = "hns";
    expect(await f.hsdRegtestReachable()).toBe(false);
    await expect(f.hsdRegtestNode("getblockchaininfo")).rejects.toThrow("disabled in pg-only");
    expect(hsd.calls).toEqual([]);
  });
});

describe("required HNS retains its admission and sentinel checks", () => {
  test("correct simulated regtest and wallet admit required mode through the real RPC wire", async () => {
    const hsd = simulatedHsd();
    const f = createHsdRegtestFixture(
      {
        HNS_REGTEST_TEST_CONTEXT: "hns",
        HNS_REGTEST_TEST_REQUIRED: "1",
        CONTROL_PLANE_POSTGRES_TEST_URL: postgres,
        HSD_REGTEST_API_KEY: "socket-free-key",
      },
      { fetch: hsd.transport },
    );
    expect(await f.hsdRegtestReachable()).toBe(true);
    expect(hsd.calls.map(({ method }) => method)).toEqual([
      "getblockchaininfo",
      "getblockhash",
      "getwalletinfo",
    ]);
    expect(hsd.calls.map(({ url }) => url)).toEqual([
      f.hsdRegtestNodeUrl,
      f.hsdRegtestNodeUrl,
      f.hsdRegtestWalletUrl,
    ]);
    expect(
      hsd.calls.every(
        ({ authorization }) =>
          authorization === `Basic ${Buffer.from("x:socket-free-key").toString("base64")}`,
      ),
    ).toBe(true);
    expect(await f.hsdRegtestHeight()).toBe(42);
  });
  test("missing PostgreSQL fails required mode before any RPC", async () => {
    for (const pg of [undefined, "", "  "]) {
      const hsd = simulatedHsd();
      const f = createHsdRegtestFixture(
        { HNS_REGTEST_TEST_REQUIRED: "1", CONTROL_PLANE_POSTGRES_TEST_URL: pg },
        { fetch: hsd.transport },
      );
      await expect(f.hsdRegtestReachable()).rejects.toThrow("PostgreSQL fixture is missing");
      expect(hsd.calls).toEqual([]);
    }
  });
  test("wrong chain, genesis and malformed wallet reject required mode", async () => {
    for (const [overrides, message, methods] of [
      [
        { getblockchaininfo: { chain: "main" } },
        "regtest required",
        ["getblockchaininfo", "getblockhash"],
      ],
      [{ getblockhash: "wrong" }, "genesis mismatch", ["getblockchaininfo", "getblockhash"]],
      [
        { getwalletinfo: null },
        "malformed readiness",
        ["getblockchaininfo", "getblockhash", "getwalletinfo"],
      ],
    ] as const) {
      const hsd = simulatedHsd(overrides);
      const f = createHsdRegtestFixture(
        { HNS_REGTEST_TEST_REQUIRED: "1", CONTROL_PLANE_POSTGRES_TEST_URL: postgres },
        { fetch: hsd.transport },
      );
      await expect(f.hsdRegtestReachable()).rejects.toThrow(message);
      expect(hsd.calls.map(({ method }) => method)).toEqual([...methods]);
    }
  });
  test("invalid node or wallet endpoint rejects before a request", async () => {
    for (const variable of ["HSD_REGTEST_NODE_URL", "HSD_REGTEST_WALLET_URL"]) {
      for (const url of ["https://127.0.0.1:14037/", "http://remote.invalid/", "not-a-url"]) {
        const hsd = simulatedHsd();
        const f = createHsdRegtestFixture(
          {
            HNS_REGTEST_TEST_REQUIRED: "1",
            CONTROL_PLANE_POSTGRES_TEST_URL: postgres,
            [variable]: url,
          },
          { fetch: hsd.transport },
        );
        await expect(f.hsdRegtestReachable()).rejects.toThrow();
        expect(hsd.calls).toEqual([]);
      }
    }
  });
  test("required transport errors propagate while default optional mode remains optional", async () => {
    const failure = new Error("simulated unreachable RPC");
    const transport = async () => {
      throw failure;
    };
    const required = createHsdRegtestFixture(
      { HNS_REGTEST_TEST_REQUIRED: "1", CONTROL_PLANE_POSTGRES_TEST_URL: postgres },
      { fetch: transport },
    );
    await expect(required.hsdRegtestReachable()).rejects.toBe(failure);
    const optional = createHsdRegtestFixture(
      { CONTROL_PLANE_POSTGRES_TEST_URL: postgres },
      { fetch: transport },
    );
    expect(await optional.hsdRegtestReachable()).toBe(false);
    const hsd = simulatedHsd();
    expect(await createHsdRegtestFixture({}, { fetch: hsd.transport }).hsdRegtestReachable()).toBe(
      false,
    );
    expect(hsd.calls).toEqual([]);
    expect(
      await createHsdRegtestFixture(
        { CONTROL_PLANE_POSTGRES_TEST_URL: postgres },
        { fetch: hsd.transport },
      ).hsdRegtestReachable(),
    ).toBe(true);
  });
  test("required completion still demands its exact sentinel and propagates writer failure", async () => {
    const writes: [string, string][] = [];
    const environment = { HNS_REGTEST_TEST_REQUIRED: "1", COMPLETE: "/socket-free/sentinel" };
    const f = createHsdRegtestFixture(environment, {
      writeSentinel: async (path, contents) => {
        writes.push([path, contents]);
      },
    });
    await expect(f.markHnsRegtestSuiteComplete("MISSING", "complete")).rejects.toThrow(
      "required in required HNS",
    );
    await f.markHnsRegtestSuiteComplete("COMPLETE", "complete");
    expect(writes).toEqual([["/socket-free/sentinel", "complete\n"]]);
    const optional = createHsdRegtestFixture(
      { HNS_REGTEST_TEST_CONTEXT: "pg-only" },
      {
        writeSentinel: async () => {
          throw new Error("unexpected write");
        },
      },
    );
    await optional.markHnsRegtestSuiteComplete("MISSING", "complete");
    const failed = createHsdRegtestFixture(environment, {
      writeSentinel: async () => {
        throw new Error("sentinel failed");
      },
    });
    await expect(failed.markHnsRegtestSuiteComplete("COMPLETE", "complete")).rejects.toThrow(
      "sentinel failed",
    );
  });
});

async function actualModule(
  context: string,
  required: string,
  configured: boolean,
): Promise<unknown> {
  const moduleUrl = new URL("./hns-regtest-node.pg-fixture.ts", import.meta.url).href;
  const source = `
    let requests=0, injected=0;
    globalThis.fetch=async (_url, init)=>{ requests++; const {method}=JSON.parse(init.body); return new Response(JSON.stringify({error:null,result: method==='getblockchaininfo'?{chain:'regtest',blocks:42}:method==='getblockhash'?'${hsdRegtestGenesis}':{id:'primary'}})); };
    try {
      const m=await import(${JSON.stringify(moduleUrl)});
      const reachable=await m.hsdRegtestReachable();
      const request=async()=>{injected++;return {};};
      const blocked=[];
      for (const [name,call] of Object.entries({node:()=>m.hsdRegtestNode('generatetoaddress',[1,'unused']),wallet:()=>m.hsdRegtestWallet('sendopen',['unused']),height:()=>m.hsdRegtestHeight(),identity:()=>m.probeHsdRegtestIdentity(request),walletProbe:()=>m.probeHsdRegtestWallet(request),required:()=>m.requireHsdRegtest(request),chain:()=>m.requireHsdRegtestChain(request)})) {
        try {await call();throw new Error(name+' escaped');} catch(error) {if(!error.message.includes('disabled in pg-only'))throw error;blocked.push(name);}
      }
      console.log(JSON.stringify({phase:'blocked',reachable,requests,injected,blocked}));
    } catch(error) {console.log(JSON.stringify({phase:'refused',error:error.message,requests,injected}));}
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? "",
      BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? "",
      CONTROL_PLANE_POSTGRES_TEST_URL: postgres,
      HNS_REGTEST_TEST_CONTEXT: context,
      HNS_REGTEST_TEST_REQUIRED: required,
      ...(configured
        ? {
            HSD_REGTEST_NODE_URL: "http://127.0.0.1:24037/",
            HSD_REGTEST_WALLET_URL: "http://127.0.0.1:24039/",
          }
        : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}
test("actual module exports block default/configured RPC in isolated PG-only children", async () => {
  for (const configured of [false, true])
    expect(await actualModule("pg-only", "0", configured)).toEqual({
      phase: "blocked",
      reachable: false,
      requests: 0,
      injected: 0,
      blocked: ["node", "wallet", "height", "identity", "walletProbe", "required", "chain"],
    });
});
test("actual module import rejects required conflicts and invalid contexts without requests", async () => {
  expect(await actualModule("pg-only", "1", false)).toEqual({
    phase: "refused",
    error: "HNS_REGTEST_TEST_CONTEXT=pg-only conflicts with HNS_REGTEST_TEST_REQUIRED=1",
    requests: 0,
    injected: 0,
  });
  expect(await actualModule("unknown", "0", true)).toEqual({
    phase: "refused",
    error: "HNS_REGTEST_TEST_CONTEXT must be hns or pg-only when provided",
    requests: 0,
    injected: 0,
  });
});
