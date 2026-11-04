import { isolatedCommitmentOrigin } from "./worker-plan.mjs";

const publicProbe =
  "megapot/commitments/megapot_commitment_598ba3414427d70a1cc262c2b38e68ab9a91d17b4e9afe25b40f57660791aea1.json";

/** Read an existing public document; never enable public bucket access or write a probe. */
export async function verifyCommitmentReader(jobs, request = (url, init) => fetch(url, init)) {
  const bindings = jobs.resources?.bindings ?? [];
  if (
    bindings.find((binding) => binding.name === "MEGAPOT_COMMITMENT_PUBLIC_ORIGIN")?.text !==
      isolatedCommitmentOrigin ||
    bindings.find((binding) => binding.name === "MEGAPOT_COMMITMENTS")?.bucket_name !==
      "pirate-megapot-commitments-e2e-staging"
  )
    throw Error("Isolated commitment reader binding differs");
  const response = await request(`${isolatedCommitmentOrigin}/${publicProbe}`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (
    response.status !== 200 ||
    !/^(?:W\/)?"9ea1063107df82c0a9416b332467975d"$/.test(response.headers.get("etag") ?? "") ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    throw Error("Isolated commitment reader probe refused");
  return { origin: isolatedCommitmentOrigin, key: publicProbe, status: response.status };
}
