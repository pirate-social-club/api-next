import { expect, test } from "bun:test";
import { videoPublicationPostId } from "./publication-identity.ts";

test("fixed UTF8/u32be SHA256 vectors, with unambiguous lengths", async () => {
  const vectors = [
    [
      "media-submission-one",
      "media-operation-one",
      "post-1acac347f141db1a5ef1523c990a32924b98b62ec4b71cd7b21340065fcf46a2",
    ],
    ["源-é", "操作-🎵", "post-21cfcadf3727492bb4401cd7ba0fff4e14629d7a883b82102f66d851182340e9"],
    ["ab", "c", "post-2ef70802d134bf058d8f61fe22ee3c51094a428c8c500acec78e12d1b48533a2"],
    ["a", "bc", "post-598e87f428629761fffb1c8478b6803f1659fa2600cf297408cd9054c162027c"],
  ];
  for (const [submissionId, operationId, expected] of vectors)
    expect(
      await videoPublicationPostId({
        submissionId: submissionId as string,
        operationId: operationId as string,
        postId: null,
      }),
    ).toBe(expected);
});
test("retains every already assigned historical ID without normalization or rotation", async () => {
  for (const postId of ["post-historical", "旧-publication"])
    expect(await videoPublicationPostId({ submissionId: "s", operationId: "o", postId })).toBe(
      postId,
    );
  for (const submissionId of ["", " s", "s\u0000", "\ud800"])
    await expect(
      videoPublicationPostId({ submissionId, operationId: "o", postId: null }),
    ).rejects.toThrow();
});
