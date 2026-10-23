import { describe, expect, test } from "bun:test";
import { makeModeratedDanceProviderCleanup } from "./moderated-dance-provider-cleanup.ts";
import { makeSongVideoCloudConvertTransport } from "./song-video-cloudconvert-transport.ts";

function fixture() {
  let jobId: string | null = "bound-job",
    tag = "original-private-tag",
    exists = true;
  let provider: "cloudconvert" | "qencode" = "cloudconvert",
    token = 0;
  let loseClaimCommit = false,
    loseIdentityCommit = false,
    loseDeleteReply = false,
    loseFinishCommit = false;
  let foreign = false,
    tagMiss = false,
    denyRead = false;
  const requests: string[] = [],
    proofs: unknown[] = [],
    queries: string[] = [];
  const call: Parameters<typeof makeModeratedDanceProviderCleanup>[0]["call"] = async (
    _label,
    sql,
    values,
  ) => {
    queries.push(sql);
    if (sql.includes("claim_moderated_dance_provider_cleanup_v1")) {
      if (loseClaimCommit) {
        loseClaimCommit = false;
        throw new Error("claim COMMIT reply lost");
      }
      return {
        effectId: "attempt:upload:normalization",
        provider,
        jobId,
        tag: provider === "qencode" ? null : tag,
        token: `lease-${++token}`,
      };
    }
    if (sql.includes("identify_moderated_dance_provider_cleanup_v1")) {
      jobId = String(values[2]);
      if (loseIdentityCommit) {
        loseIdentityCommit = false;
        throw new Error("identity COMMIT reply lost");
      }
      return null;
    }
    if (sql.includes("finish_moderated_dance_provider_cleanup_v1")) {
      proofs.push(JSON.parse(String(values[2])));
      if (loseFinishCommit) {
        loseFinishCommit = false;
        throw new Error("result COMMIT reply lost");
      }
      return null;
    }
    throw new Error("Unexpected cleanup query");
  };
  const transport = makeSongVideoCloudConvertTransport({
    apiKey: "test-only",
    fetch: async (url, init) => {
      requests.push(`${init.method} ${url}`);
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-only" });
      const job = { id: "bound-job", tag: foreign ? "foreign-tag" : tag, status: "finished" };
      if (url.includes("filter%5Btag%5D"))
        return Response.json({ data: tagMiss ? [] : [job], links: { next: null } });
      if (init.method === "GET")
        return denyRead
          ? new Response(null, { status: 403 })
          : exists
            ? Response.json({ data: job })
            : new Response(null, { status: 404 });
      if (init.method === "DELETE") {
        exists = false;
        if (loseDeleteReply) {
          loseDeleteReply = false;
          throw new Error("delete reply lost after deletion");
        }
        return new Response(null, { status: 204 });
      }
      throw new Error("No create/start belongs to cleanup");
    },
  });
  return {
    make: (enabled = true) =>
      makeModeratedDanceProviderCleanup({ call, provider: enabled ? transport : undefined }),
    requests,
    proofs,
    queries,
    unknownCreate: () => {
      jobId = null;
    },
    qencode: () => {
      provider = "qencode";
    },
    absent: () => {
      exists = false;
    },
    foreign: () => {
      foreign = true;
    },
    miss: () => {
      tagMiss = true;
    },
    deny: () => {
      denyRead = true;
    },
    loseClaim: () => {
      loseClaimCommit = true;
    },
    loseIdentity: () => {
      loseIdentityCommit = true;
    },
    loseDelete: () => {
      loseDeleteReply = true;
    },
    loseFinish: () => {
      loseFinishCommit = true;
    },
  };
}

describe("private Dance provider cleanup", () => {
  test("deletes only the exact observed job under the durable original effect", async () => {
    const f = fixture();
    await f.make().run();
    expect(f.requests).toEqual([
      "GET https://api.cloudconvert.com/v2/jobs/bound-job",
      "DELETE https://api.cloudconvert.com/v2/jobs/bound-job",
    ]);
    expect(f.proofs).toEqual([
      { outcome: "deleted", jobId: "bound-job", tag: "original-private-tag" },
    ]);
  });
  test("a lost deletion reply recovers through the same job's absence without another delete", async () => {
    const f = fixture();
    f.loseDelete();
    await f.make().run();
    await f.make().run();
    expect(f.requests.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
    expect(f.proofs).toEqual([
      {
        outcome: "unknown",
        jobId: "bound-job",
        tag: "original-private-tag",
        reason: "provider_unknown",
      },
      { outcome: "observed_absent", jobId: "bound-job", tag: "original-private-tag" },
    ]);
  });
  test("unknown creation resolves its original tag and commits identity before deleting", async () => {
    const f = fixture();
    f.unknownCreate();
    await f.make().run();
    expect(f.queries.map((s) => s.split("(")[0])).toEqual([
      "SELECT claim_moderated_dance_provider_cleanup_v1",
      "SELECT identify_moderated_dance_provider_cleanup_v1",
      "SELECT finish_moderated_dance_provider_cleanup_v1",
    ]);
    expect(f.requests.some((s) => s.startsWith("POST"))).toBe(false);
    expect(f.proofs[0]).toMatchObject({ outcome: "deleted", jobId: "bound-job" });
  });
  test("a tag miss cannot prove an uncertain create never happened", async () => {
    const f = fixture();
    f.unknownCreate();
    f.miss();
    await f.make().run();
    expect(f.proofs).toEqual([
      {
        outcome: "unknown",
        jobId: null,
        tag: "original-private-tag",
        reason: "identity_unresolved",
      },
    ]);
    expect(f.requests).toHaveLength(1);
  });
  test("a foreign tag cannot authorize deletion", async () => {
    const f = fixture();
    f.foreign();
    await f.make().run();
    expect(f.requests).toHaveLength(1);
    expect(f.proofs[0]).toMatchObject({ outcome: "unknown", reason: "identity_mismatch" });
  });
  test("a prior bound job's 404 is observed absence, with no mutation", async () => {
    const f = fixture();
    f.absent();
    await f.make().run();
    expect(f.requests).toHaveLength(1);
    expect(f.proofs[0]).toMatchObject({ outcome: "observed_absent" });
  });
  test("access denial is not absence", async () => {
    const f = fixture();
    f.deny();
    await f.make().run();
    expect(f.requests).toHaveLength(1);
    expect(f.proofs[0]).toMatchObject({ outcome: "unknown", reason: "provider_unknown" });
  });
  test("legacy Qencode liability remains unresolved without a deletion route", async () => {
    const f = fixture();
    f.qencode();
    await f.make().run();
    expect(f.requests).toHaveLength(0);
    expect(f.proofs[0]).toMatchObject({ outcome: "unknown", reason: "route_unavailable" });
  });
  test("missing existing credentials cannot produce deletion evidence", async () => {
    const f = fixture();
    await f.make(false).run();
    expect(f.requests).toHaveLength(0);
    expect(f.proofs[0]).toMatchObject({ outcome: "unknown", reason: "route_unavailable" });
  });
  test("uncertain claim COMMIT prevents every provider call", async () => {
    const f = fixture();
    f.loseClaim();
    await expect(f.make().run()).rejects.toThrow("claim COMMIT");
    expect(f.requests).toHaveLength(0);
  });
  test("uncertain identity COMMIT prevents DELETE; next invocation observes the bound identity", async () => {
    const f = fixture();
    f.unknownCreate();
    f.loseIdentity();
    await expect(f.make().run()).rejects.toThrow("identity COMMIT");
    expect(f.requests).toHaveLength(1);
    await f.make().run();
    expect(f.requests.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
  });
  test("uncertain result COMMIT escapes without an in-call provider retry", async () => {
    const f = fixture();
    f.loseFinish();
    await expect(f.make().run()).rejects.toThrow("result COMMIT");
    expect(f.requests.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
    await f.make().run();
    expect(f.requests.filter((s) => s.startsWith("DELETE"))).toHaveLength(1);
    expect(f.proofs[1]).toMatchObject({ outcome: "observed_absent" });
  });
});
