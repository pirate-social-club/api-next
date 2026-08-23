import { describe, expect, test } from "bun:test";

import {
  auditSecretBoundary,
  type ChangedFile,
  hasTopLevelIdTokenWrite,
  listPullRequestFiles,
  pathsRequiringContent,
  referencedSecretNames,
  workflowTriggers,
} from "./secret-boundary-check";

const PINNED = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";

const COMPLIANT_AUDIT_SCRIPT = `
  const parameters = {
    viewSecretValue: "false",
    expandSecretReferences: "false",
    recursive: "false",
  };
`;

/** Built by concatenation so the fixture is not itself a template placeholder. */
function expression(body: string): string {
  return `$${"{{"} ${body} }}`;
}

function changed(path: string, status: ChangedFile["status"] = "modified"): ChangedFile {
  return { path, status };
}

function audit(files: readonly ChangedFile[], contents: Record<string, string> = {}) {
  return auditSecretBoundary({ files, contents: new Map(Object.entries(contents)) });
}

describe("workflow parsing", () => {
  test("reads block, inline, and quoted trigger declarations", () => {
    expect(workflowTriggers("on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n")).toEqual([
      "push",
      "workflow_dispatch",
    ]);
    expect(workflowTriggers("on: [push, pull_request]\n")).toEqual(["push", "pull_request"]);
    expect(workflowTriggers('"on":\n  pull_request_target:\n    types: [opened]\n')).toEqual([
      "pull_request_target",
    ]);
  });

  test("separates workflow wide OIDC grants from job scoped ones", () => {
    expect(hasTopLevelIdTokenWrite("permissions:\n  id-token: write\njobs:\n  a:\n")).toBe(true);
    expect(hasTopLevelIdTokenWrite("permissions: write-all\n")).toBe(true);
    expect(
      hasTopLevelIdTokenWrite("jobs:\n  audit:\n    permissions:\n      id-token: write\n"),
    ).toBe(false);
  });

  test("ignores the ambient GITHUB_TOKEN when collecting secret references", () => {
    const content = `a: ${expression("secrets.GITHUB_TOKEN")}\nb: ${expression("secrets.CLOUDFLARE_API_TOKEN")}\n`;
    expect(referencedSecretNames(content)).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });
});

describe("secret boundary audit", () => {
  test("only reads content for workflows and non-test scripts that survive the change", () => {
    expect(
      pathsRequiringContent([
        changed(".github/workflows/ci.yml"),
        changed("scripts/audit.ts"),
        changed("scripts/audit.test.ts"),
        changed("packages/platform-cf/src/index.ts"),
        changed(".github/workflows/gone.yml", "removed"),
      ]),
    ).toEqual([".github/workflows/ci.yml", "scripts/audit.ts"]);
  });

  test("passes a change that keeps every invariant", () => {
    const violations = audit(
      [changed("scripts/infisical-secret-drift-audit.ts"), changed(".github/workflows/ci.yml")],
      {
        "scripts/infisical-secret-drift-audit.ts": COMPLIANT_AUDIT_SCRIPT,
        ".github/workflows/ci.yml": `name: ci\non:\n  pull_request:\njobs:\n  check:\n    steps:\n      - uses: ${PINNED}\n`,
      },
    );
    expect(violations).toEqual([]);
  });

  test("rejects a pull request that touches the check itself", () => {
    const violations = audit([changed("scripts/secret-boundary-check.ts")]);
    expect(violations.map((violation) => violation.kind)).toEqual(["guarded-file-modified"]);
  });

  test("rejects removing or renaming a file that carries the contract", () => {
    expect(audit([changed(".github/workflows/secret-drift.yml", "removed")])[0]?.kind).toBe(
      "required-file-removed",
    );
    expect(
      audit([
        {
          path: "scripts/moved-audit.ts",
          status: "renamed",
          previousPath: "scripts/infisical-secret-drift-audit.ts",
        },
      ]).map((violation) => violation.kind),
    ).toContain("required-file-removed");
  });

  test("rejects dropping or inverting the secret value guards", () => {
    expect(
      audit([changed("scripts/infisical-secret-drift-audit.ts")], {
        "scripts/infisical-secret-drift-audit.ts": 'const p = { viewSecretValue: "true" };',
      }).map((violation) => violation.reason),
    ).toEqual([
      'Infisical secret listing must keep the literal viewSecretValue: "false".',
      'Infisical secret listing must keep the literal expandSecretReferences: "false".',
      "Infisical secret listing must never request secret values or expanded references.",
    ]);
  });

  test("rejects reading the returned secret value field", () => {
    expect(
      audit([changed("scripts/new-audit.ts")], {
        "scripts/new-audit.ts": `${COMPLIANT_AUDIT_SCRIPT}\nconst leak = entry.secretValue;\n`,
      }).map((violation) => violation.kind),
    ).toEqual(["secret-value-exposure"]);
  });

  test("rejects handing credentials or an OIDC token to pull request code", () => {
    const violations = audit([changed(".github/workflows/leaky.yml")], {
      ".github/workflows/leaky.yml": [
        "name: leaky",
        "on:",
        "  pull_request:",
        "jobs:",
        "  audit:",
        "    permissions:",
        "      id-token: write",
        "    steps:",
        `      - uses: ${PINNED}`,
        "      - run: bun run audit:secrets",
        "        env:",
        `          CLOUDFLARE_API_TOKEN: ${expression("secrets.CLOUDFLARE_API_TOKEN")}`,
      ].join("\n"),
    });
    expect(violations.map((violation) => violation.kind)).toEqual([
      "pull-request-secret-exposure",
      "pull-request-secret-exposure",
    ]);
  });

  test("rejects a second pull_request_target workflow and workflow wide OIDC", () => {
    const violations = audit([changed(".github/workflows/other.yml")], {
      ".github/workflows/other.yml":
        "name: other\non:\n  pull_request_target:\npermissions:\n  id-token: write\njobs:\n  a:\n",
    });
    expect(violations.map((violation) => violation.kind)).toEqual([
      "pull-request-target-workflow",
      "pull-request-secret-exposure",
      "unscoped-id-token",
    ]);
  });

  test("rejects giving the credential bearing workflow a new trigger", () => {
    const violations = audit([changed(".github/workflows/secret-drift.yml")], {
      ".github/workflows/secret-drift.yml": `name: secret-drift\non:\n  push:\n    branches: [main]\n  issue_comment:\njobs:\n  audit:\n    steps:\n      - uses: ${PINNED}\n`,
    });
    expect(violations).toEqual([
      {
        kind: "credential-workflow-trigger",
        path: ".github/workflows/secret-drift.yml",
        reason:
          'Credential bearing workflow may only trigger on push, schedule, workflow_dispatch; found "issue_comment".',
      },
    ]);
  });

  test("rejects unpinned actions but accepts local and pinned ones", () => {
    const violations = audit([changed(".github/workflows/ci.yml")], {
      ".github/workflows/ci.yml": [
        "name: ci",
        "on:",
        "  push:",
        "jobs:",
        "  check:",
        "    steps:",
        "      - uses: ./.github/actions/local",
        `      - uses: ${PINNED}`,
        "      - uses: oven-sh/setup-bun@v2",
      ].join("\n"),
    });
    expect(violations).toEqual([
      {
        kind: "unpinned-action",
        path: ".github/workflows/ci.yml",
        reason: 'Action "oven-sh/setup-bun@v2" is not pinned to a full 40 character commit SHA.',
      },
    ]);
  });

  test("fails closed when content is unreadable or the change list is truncated", () => {
    expect(audit([changed(".github/workflows/ci.yml")])[0]?.kind).toBe("content-unavailable");
    expect(auditSecretBoundary({ files: [], contents: new Map(), truncated: true })[0]?.kind).toBe(
      "changed-file-list-truncated",
    );
  });
});

describe("pull request file listing", () => {
  test("stops at the first short page and reports rename and content metadata", async () => {
    const seen: string[] = [];
    const { files, truncated } = await listPullRequestFiles({
      apiUrl: "https://api.test",
      repository: "owner/repo",
      pullNumber: 7,
      token: "test-token",
      request: async (url, init) => {
        seen.push(url);
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
        return new Response(
          JSON.stringify([
            {
              filename: "scripts/audit.ts",
              status: "renamed",
              previous_filename: "scripts/old-audit.ts",
              contents_url: "https://api.test/repos/fork/repo/contents/scripts/audit.ts?ref=abc",
            },
          ]),
        );
      },
    });

    expect(seen).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(files).toEqual([
      {
        path: "scripts/audit.ts",
        status: "renamed",
        previousPath: "scripts/old-audit.ts",
        contentsUrl: "https://api.test/repos/fork/repo/contents/scripts/audit.ts?ref=abc",
      },
    ]);
  });
});
