import { expect, test } from "bun:test";
import { GuestBadRequest } from "@pirate/contracts";
import { GuestProofMaterial } from "@pirate/platform-cf/guest-proof-crypto";
import {
  ensureGuestCsrfCookie,
  writeGuestResponseCookies,
} from "./guest-browser-response-cookies.ts";

const id = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "BBBBBBBBBBBBBBBBBBBBBA";
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("credential issuance, carried renewal and intent nonce use exact host-only attributes", async () => {
  const material = await GuestProofMaterial.issue();
  const nonce = await GuestProofMaterial.issue();
  const headers = writeGuestResponseCookies({
    headers: new Headers({ "cache-control": "public", "set-cookie": "ordinary_session=preserved" }),
    effects: [
      { kind: "credential", action: "issue", credentialId: id },
      { kind: "credential", action: "refresh", credentialId: other },
      { kind: "intent", action: "issue", intentId: `gai_${id}` },
    ],
    issuedProofs: [
      { kind: "credential", id, material },
      { kind: "intent", id: `gai_${id}`, material: nonce },
    ],
    carriedCredentials: [{ credentialId: other, secret }],
  });
  const cookies = headers.getSetCookie();
  expect(cookies).toContain("ordinary_session=preserved");
  expect(cookies).toContain(
    `__Host-pirate_guest_${id}=${material.valueForCookie()}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`,
  );
  expect(cookies).toContain(
    `__Host-pirate_guest_${other}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000`,
  );
  expect(cookies).toContain(
    `__Host-pirate_guest_attach_${id}=${nonce.valueForCookie()}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`,
  );
  expect(cookies.some((cookie) => /Domain=/u.test(cookie))).toBe(false);
  expect(headers.get("cache-control")).toBe("private, no-store");
  expect(JSON.stringify(material)).not.toContain(material.valueForCookie());
});

test("delayed issuance has its own cookie name and explicit cleanup expires only named proofs", async () => {
  const first = await GuestProofMaterial.issue();
  const second = await GuestProofMaterial.issue();
  const write = (credentialId: string, material: GuestProofMaterial) =>
    writeGuestResponseCookies({
      headers: new Headers(),
      effects: [{ kind: "credential", action: "issue", credentialId }],
      issuedProofs: [{ kind: "credential", id: credentialId, material }],
      carriedCredentials: [],
    }).getSetCookie()[0];
  expect(write(id, first)?.split("=")[0]).not.toBe(write(other, second)?.split("=")[0]);
  const cookies = writeGuestResponseCookies({
    headers: new Headers(),
    effects: [
      { kind: "credential", action: "expire", credentialId: id },
      { kind: "intent", action: "expire", intentId: `gai_${other}` },
    ],
    issuedProofs: [],
    carriedCredentials: [],
  }).getSetCookie();
  expect(cookies).toEqual([
    `__Host-pirate_guest_${id}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `__Host-pirate_guest_attach_${other}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ]);
});

test("missing issuance material, proof confusion and malformed refresh refuse without partial mutation", async () => {
  const original = new Headers({ "x-preserved": "yes" });
  const material = await GuestProofMaterial.issue();
  for (const proofs of [
    [],
    [{ kind: "intent" as const, id: `gai_${id}`, material }],
    [{ kind: "credential" as const, id: other, material }],
  ]) {
    expect(() =>
      writeGuestResponseCookies({
        headers: original,
        effects: [{ kind: "credential", action: "issue", credentialId: id }],
        issuedProofs: proofs,
        carriedCredentials: [],
      }),
    ).toThrow(GuestBadRequest);
  }
  for (const carried of [
    [],
    [{ credentialId: id, secret: "private-invalid-material" }],
    [
      { credentialId: id, secret },
      { credentialId: id, secret },
    ],
  ]) {
    try {
      writeGuestResponseCookies({
        headers: original,
        effects: [
          { kind: "credential", action: "expire", credentialId: other },
          { kind: "credential", action: "refresh", credentialId: id },
        ],
        issuedProofs: [],
        carriedCredentials: carried,
      });
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(GuestBadRequest);
      expect(JSON.stringify(error)).not.toContain("private-invalid-material");
    }
  }
  expect(original.getSetCookie()).toEqual([]);
  expect(original.get("cache-control")).toBeNull();
});

test("credential and attachment issuance cannot reuse one random proof", async () => {
  const material = await GuestProofMaterial.issue();
  expect(() =>
    writeGuestResponseCookies({
      headers: new Headers(),
      effects: [
        { kind: "credential", action: "issue", credentialId: id },
        { kind: "intent", action: "issue", intentId: `gai_${id}` },
      ],
      issuedProofs: [
        { kind: "credential", id, material },
        { kind: "intent", id: `gai_${id}`, material },
      ],
      carriedCredentials: [],
    }),
  ).toThrow(GuestBadRequest);
});

test("guest CSRF is readable, independently issued and never renews or selects ownership", async () => {
  const first = await ensureGuestCsrfCookie(new Headers(), null);
  const second = await ensureGuestCsrfCookie(new Headers(), null);
  const cookie = first.getSetCookie()[0];
  expect(cookie).toMatch(
    /^__Host-pirate_guest_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Lax; Max-Age=34560000$/u,
  );
  expect(cookie).not.toContain("HttpOnly");
  expect(cookie).not.toBe(second.getSetCookie()[0]);
  const retained = await ensureGuestCsrfCookie(new Headers(), secret);
  expect(retained.getSetCookie()).toEqual([]);
  expect(retained.get("cache-control")).toBe("private, no-store");
  expect(() =>
    writeGuestResponseCookies({
      headers: first,
      effects: [{ kind: "credential", action: "refresh", credentialId: id }],
      issuedProofs: [],
      carriedCredentials: [],
    }),
  ).toThrow(GuestBadRequest);
});
