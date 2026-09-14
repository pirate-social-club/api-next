import { describe, expect, test } from "bun:test";
import type { Client } from "pg";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

type CatalogOptions = Readonly<{
  major: 17 | 18;
  invalidNotNull?: boolean;
  notNullDefinition?: string;
  notNullName?: string;
  nullable?: boolean;
  ordinaryConstraint?: string;
  domainNotNull?: boolean;
}>;

function catalog(options: CatalogOptions): Pick<Client, "query"> {
  return {
    query: async (sql: string) => {
      if (sql === "SHOW server_version_num") {
        return { rows: [{ server_version_num: `${options.major}0600` }] } as never;
      }
      if (sql.includes("prokind NOT IN")) return { rows: [{ count: "0" }] } as never;
      if (sql.includes("c.contype='n'")) {
        return {
          rows: [
            {
              relname: "example",
              attname: "value",
              conname: options.notNullName ?? "example_value_not_null",
              convalidated: !options.invalidNotNull,
              conenforced: true,
              condeferrable: false,
              condeferred: false,
              conislocal: true,
              coninhcount: 0,
              connoinherit: false,
              conparentid: 0,
              conkey: [1],
              attisdropped: false,
              attnotnull: true,
              definition:
                options.notNullDefinition ??
                (options.invalidNotNull ? "NOT NULL value NOT VALID" : "NOT NULL value"),
            },
          ],
        } as never;
      }
      if (sql.includes("pg_catalog.pg_attribute")) {
        return {
          rows: [{ relname: "example", attname: "value", attnotnull: !options.nullable }],
        } as never;
      }
      if (sql.includes("pg_catalog.pg_constraint")) {
        return {
          rows: [
            ...(options.ordinaryConstraint
              ? [{ relname: "example", contype: "c", definition: options.ordinaryConstraint }]
              : []),
            ...(options.domainNotNull
              ? [
                  {
                    relname: null,
                    conname: "shape_domain_not_null",
                    contype: "n",
                    convalidated: true,
                    definition: "NOT NULL VALUE",
                  },
                ]
              : []),
          ],
        } as never;
      }
      return { rows: [] } as never;
    },
  };
}

describe("reset schema shape", () => {
  test("canonical PostgreSQL 18 NOT NULL mirrors preserve the PostgreSQL 17 digest", async () => {
    const postgres17 = await readResetSchemaShape(catalog({ major: 17 }));
    const postgres18 = await readResetSchemaShape(catalog({ major: 18 }));

    expect(postgres18).toEqual(postgres17);
  });

  test("rejects altered PostgreSQL 18 NOT NULL constraint metadata", async () => {
    await expect(
      readResetSchemaShape(catalog({ major: 18, invalidNotNull: true })),
    ).rejects.toThrow("reset_baseline_shape_unsupported");
  });

  test("rejects a noncanonical PostgreSQL 18 NOT NULL constraint name", async () => {
    await expect(
      readResetSchemaShape(catalog({ major: 18, notNullName: "explicit_name" })),
    ).rejects.toThrow("reset_baseline_shape_unsupported");
  });

  test("rejects a changed PostgreSQL 18 NOT NULL constraint definition", async () => {
    await expect(
      readResetSchemaShape(catalog({ major: 18, notNullDefinition: "NOT NULL value NOT VALID" })),
    ).rejects.toThrow("reset_baseline_shape_unsupported");
  });

  test("retains column nullability in the digest", async () => {
    const required = await readResetSchemaShape(catalog({ major: 18 }));
    const nullable = await readResetSchemaShape(catalog({ major: 18, nullable: true }));

    expect(nullable.sha256).not.toBe(required.sha256);
  });

  test("retains ordinary constraints in the digest", async () => {
    const original = await readResetSchemaShape(catalog({ major: 18 }));
    const constrained = await readResetSchemaShape(
      catalog({ major: 18, ordinaryConstraint: "CHECK ((value > 0))" }),
    );

    expect(constrained.sha256).not.toBe(original.sha256);
  });

  test("retains domain NOT NULL constraints in the digest", async () => {
    const original = await readResetSchemaShape(catalog({ major: 18 }));
    const constrained = await readResetSchemaShape(catalog({ major: 18, domainNotNull: true }));

    expect(constrained.sha256).not.toBe(original.sha256);
  });
});
