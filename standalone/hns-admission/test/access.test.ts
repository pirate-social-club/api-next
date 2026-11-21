import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accessData, accessLayer } from "../src/access.ts";
import { HttpAccess } from "../src/http.ts";
import { binding, hash } from "./fixtures.ts";

test("HTTP signatures bind method, path, body, installation and expiry without an operator account", async () => {
  const controller = privateKeyToAccount(generatePrivateKey());
  const installation = privateKeyToAccount(generatePrivateKey());
  const b = {
    ...binding,
    controller: controller.address.toLowerCase(),
    installationKey: installation.address.toLowerCase(),
  };
  const profile = {
    network: b.network,
    tld: b.tld,
    chainId: b.chainId,
    registry: b.registry,
    wrapper: b.wrapper,
    controller: b.controller,
    communityId: b.communityId,
    sourceSha256: b.sourceSha256,
  };
  const issuedAt = Math.floor(Date.now() / 1000);
  const deadline = issuedAt + 120;
  const path = "/v1/ceremonies",
    body = "{}";
  const signed = async (
    account: typeof controller,
    target = path,
    data = body,
    time = issuedAt,
    until = deadline,
  ) => {
    const signature = await account.signTypedData(
      await accessData(b, "POST", target, data, hash, time, until),
    );
    return new Request("https://admission.test" + target, {
      method: "POST",
      body: data,
      headers: {
        "x-pirate-actor": account.address.toLowerCase(),
        "x-pirate-nonce": hash,
        "x-pirate-issued-at": String(time),
        "x-pirate-deadline": String(until),
        "x-pirate-signature": signature,
      },
    });
  };
  const run = (request: Request, raw = body, selected = b) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const access = yield* HttpAccess;
        return yield* access
          .authorize(request, selected, raw)
          .pipe(Effect.result);
      }).pipe(Effect.provide(accessLayer([profile]))),
    );
  const valid = await signed(controller);
  assert.equal((await run(valid))._tag, "Success");
  assert.equal((await run(valid, '{"changed":true}'))._tag, "Failure");
  const moved = new Request(
    "https://admission.test/v1/ceremonies/" + hash + "/cancel",
    valid,
  );
  assert.equal((await run(moved))._tag, "Failure");
  assert.equal(
    (await run(valid, body, { ...b, installationId: "0x" + "33".repeat(32) }))
      ._tag,
    "Failure",
  );
  assert.equal((await run(await signed(installation)))._tag, "Failure");
  assert.equal(
    (
      await run(
        await signed(installation, "/v1/ceremonies/" + hash + "/observe"),
      )
    )._tag,
    "Success",
  );
  assert.equal(
    (
      await run(
        await signed(controller, path, body, issuedAt - 400, issuedAt - 100),
      )
    )._tag,
    "Failure",
  );
});

test("mainnet publication stays disabled until the selected deployment profile is frozen", async () => {
  const b = { ...binding, network: "main" as const };
  const profile = {
    network: b.network,
    tld: b.tld,
    chainId: b.chainId,
    registry: b.registry,
    wrapper: b.wrapper,
    controller: b.controller,
    communityId: b.communityId,
    sourceSha256: b.sourceSha256,
  };
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const access = yield* HttpAccess;
      return yield* access
        .authorize(
          new Request(
            "https://admission.test/v1/ceremonies/" + hash + "/consent",
            { method: "POST" },
          ),
          b,
          "{}",
        )
        .pipe(Effect.flip);
    }).pipe(Effect.provide(accessLayer([profile]))),
  );
  assert.equal(error.reason, "publication_not_enabled");
});
