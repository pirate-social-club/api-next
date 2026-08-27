import { describe, expect, test } from "bun:test";
import {
  isGeneratedPlatformPiratePlaceholderV1,
  isPlatformPirateLabelV1,
  isReservedPlatformPirateLabelV1,
  platformPirateConfusabilityKeyV1,
  platformPirateConfusabilityPolicyV1Hash,
  platformPirateHandleStateV1Hash,
  platformPirateLabelPolicyV1,
  platformPirateLabelPolicyV1Hash,
  platformPirateRenameRequestV1Hash,
  platformPirateRenameTransitionV1Hash,
  platformPirateReservedLabelsV1Hash,
} from "./platform-pirate-rename.ts";

describe("platform Pirate cleanup rename", () => {
  test("reproduces every ratified canonical vector", () => {
    const reserved = platformPirateReservedLabelsV1Hash();
    expect(reserved).toEqual({
      bytes: 294,
      preimage:
        '["pirate-platform-reserved-labels-v1",1,["abuse","admin","api","app","auth","billing","blog","cdn","dev","docs","gateway","help","hns","login","logout","mail","mod","moderator","new","official","pirate","root","security","settings","staff","staging","status","support","system","www"],["new-"]]',
      sha256: "e7f1a3e99c5eb1bd51e880db3aa6c7caeca83f2b7dcce4dfddb54c45c49ea304",
    });
    const confusability = platformPirateConfusabilityPolicyV1Hash();
    expect(confusability).toEqual({
      bytes: 116,
      preimage:
        '["pirate-platform-confusability-v1",1,"remove-hyphen",[["0","o"],["1","l"],["3","e"],["4","a"],["5","s"],["7","t"]]]',
      sha256: "b50884c3e97a4ea50fc6da0c2b0d15669bcb0647886011521b5dbb1fd7ddfa92",
    });
    expect(platformPirateLabelPolicyV1Hash()).toEqual({
      bytes: 266,
      preimage:
        '["pirate-platform-label-policy-v1","pirate_ascii_ldh_3_32_v1",1,"pirate_platform_reserved_labels_v1",1,"e7f1a3e99c5eb1bd51e880db3aa6c7caeca83f2b7dcce4dfddb54c45c49ea304","pirate_ascii_skeleton_v1",1,"b50884c3e97a4ea50fc6da0c2b0d15669bcb0647886011521b5dbb1fd7ddfa92"]',
      sha256: "7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873",
    });
    const current = platformPirateHandleStateV1Hash({
      platform_handle_id: "platform_handle_01",
      owner_persona_id: "persona_public_01",
      generation: 1,
      handle_label: "new-0123456789abcdefabcd",
      state: "active",
      cleanup_rename_consumed: false,
      redirect_to_label: null,
    });
    expect(current).toEqual({
      bytes: 125,
      preimage:
        '["pirate-platform-handle-state-v1","platform_handle_01","persona_public_01",1,"new-0123456789abcdefabcd","active",false,null]',
      sha256: "ccae7462c76c083336c67a4081fa52af70082fb67b716dc4be7820c2e1536fe2",
    });
    const request = platformPirateRenameRequestV1Hash({
      actor_account_id: "account_private_01",
      persona_id: "persona_public_01",
      platform_handle_id: "platform_handle_01",
      expected_state_hash: current.sha256,
      desired_label: "captain-data",
      label_policy_hash: platformPirateLabelPolicyV1().label_policy_hash,
      idempotency_key: "rename-key-01",
    });
    expect(request).toEqual({
      bytes: 305,
      preimage:
        '["pirate-platform-handle-rename-request-v1","/platform-pirate-handles/rename","account_private_01","persona_public_01","platform_handle_01","ccae7462c76c083336c67a4081fa52af70082fb67b716dc4be7820c2e1536fe2","captain-data","7139c5f71b651833a68b14d03b2ef93f9b528b73bd53c455546cdb10a54eb873","rename-key-01"]',
      sha256: "9b7ff2631eab537cd24e4445da1cf0d8e767f7af795cccc4938736de88a18f22",
    });
    expect(
      platformPirateRenameTransitionV1Hash({
        platform_handle_id: "platform_handle_01",
        owner_persona_id: "persona_public_01",
        previous_generation: 1,
        previous_label: "new-0123456789abcdefabcd",
        next_generation: 2,
        next_label: "captain-data",
        previous_next_state: "redirect",
        previous_redirect_to_label: "captain-data",
        rename_request_hash: request.sha256,
      }),
    ).toEqual({
      bytes: 227,
      preimage:
        '["pirate-platform-handle-rename-transition-v1","platform_handle_01","persona_public_01",1,"new-0123456789abcdefabcd",2,"captain-data","redirect","captain-data","9b7ff2631eab537cd24e4445da1cf0d8e767f7af795cccc4938736de88a18f22"]',
      sha256: "add91155bffd0b60c4c94a39453b3a6abde334cf25004ae707a43fa8185ac89c",
    });
  });

  test("keeps grammar, source eligibility, reservations, and skeleton separate", () => {
    expect(isPlatformPirateLabelV1("captain-data")).toBe(true);
    for (const value of ["ab", "CAPTAIN", " captain", "captain.pirate", "xn--captain", "a--b"])
      expect(isPlatformPirateLabelV1(value)).toBe(false);
    expect(isGeneratedPlatformPiratePlaceholderV1("new-0123456789abcdefabcd")).toBe(true);
    expect(isGeneratedPlatformPiratePlaceholderV1("new-0123456789abcdefabc")).toBe(false);
    expect(isGeneratedPlatformPiratePlaceholderV1("new-0123456789abcdefabcD")).toBe(false);
    expect(isReservedPlatformPirateLabelV1("new-abc")).toBe(true);
    expect(isReservedPlatformPirateLabelV1("admin")).toBe(true);
    expect(isReservedPlatformPirateLabelV1("newbie")).toBe(false);
    expect(platformPirateConfusabilityKeyV1("captain-data")).toBe("captaindata");
    expect(platformPirateConfusabilityKeyV1("c4pt4in-d4t4")).toBe("captaindata");
  });

  test("rejects element substitution and cross-domain reuse", () => {
    const base = platformPirateLabelPolicyV1Hash();
    const changed = platformPirateHandleStateV1Hash({
      platform_handle_id: "pirate_ascii_ldh_3_32_v1",
      owner_persona_id: "persona",
      generation: 1,
      handle_label: "captain-data",
      state: "active",
      cleanup_rename_consumed: false,
      redirect_to_label: null,
    });
    expect(changed.sha256).not.toBe(base.sha256);
    expect(
      platformPirateRenameRequestV1Hash({
        actor_account_id: "account_private_02",
        persona_id: "persona_public_01",
        platform_handle_id: "platform_handle_01",
        expected_state_hash: "c".repeat(64),
        desired_label: "captain-data",
        label_policy_hash: base.sha256,
        idempotency_key: "rename-key-01",
      }).sha256,
    ).not.toBe("9b7ff2631eab537cd24e4445da1cf0d8e767f7af795cccc4938736de88a18f22");
  });
});
