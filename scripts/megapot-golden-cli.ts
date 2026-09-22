import {
  MegapotBaseSepoliaGoldenFailed,
  parseMegapotGoldenInput,
  runMegapotBaseSepoliaGolden,
} from "./megapot-base-sepolia-golden.ts";
import {
  collectMultiGoldenPreflight,
  runMultiGolden,
} from "./megapot-base-sepolia-golden-multi.ts";
import { parseMultiGoldenInput } from "./megapot-golden-multi-input.ts";
import {
  type MegapotParticipantPreflight,
  parseMegapotParticipantPreflight,
} from "./megapot-participant-preflight-artifact.ts";

function parseOptions(args: readonly string[]) {
  const execute = args.includes("--execute");
  const confirmed = args.includes("--confirm-base-sepolia");
  const qualifyStudy = args.includes("--qualify-study");
  const inputIndex = args.indexOf("--input");
  const input = inputIndex < 0 ? undefined : args[inputIndex + 1];
  const preflightIndex = args.indexOf("--participant-preflight");
  const participantPreflight = preflightIndex < 0 ? undefined : args[preflightIndex + 1];
  const allowed = new Set([
    "--execute",
    "--confirm-base-sepolia",
    "--qualify-study",
    "--input",
    input,
    "--participant-preflight",
    participantPreflight,
  ]);
  const unknown = args.find((argument) => !allowed.has(argument));
  if (
    unknown !== undefined ||
    input === undefined ||
    input.startsWith("--") ||
    (execute && (participantPreflight === undefined || participantPreflight.startsWith("--"))) ||
    (!execute && participantPreflight !== undefined) ||
    execute !== confirmed ||
    (qualifyStudy && !execute)
  ) {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "Use --input PATH for dry-run; writes also require --participant-preflight PATH, --execute, and --confirm-base-sepolia. Add --qualify-study only after an eligible drawing is open.",
    );
  }
  return {
    execute,
    qualifyStudy,
    input,
    ...(participantPreflight === undefined ? {} : { participantPreflight }),
  };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  if (args.includes("--multi-participant")) {
    const value = (flag: string) => {
      const i = args.indexOf(flag);
      return i < 0 ? undefined : args[i + 1];
    };
    const inputPath = value("--input");
    const journalPath = value("--journal");
    const collectKey = value("--collect-preflight");
    const ceremonyReference = value("--ceremony-reference");
    const execute = args.includes("--execute");
    const reconcileOnly = args.includes("--reconcile-only");
    const allowed = new Set([
      "--multi-participant",
      "--input",
      inputPath,
      "--journal",
      journalPath,
      "--execute",
      "--confirm-base-sepolia",
      "--reconcile-only",
      "--collect-preflight",
      collectKey,
      "--ceremony-reference",
      ceremonyReference,
    ]);
    if (
      !inputPath ||
      inputPath.startsWith("--") ||
      args.some((a) => !allowed.has(a)) ||
      execute !== args.includes("--confirm-base-sepolia") ||
      (reconcileOnly && !execute) ||
      (execute && !collectKey && (!journalPath || journalPath.startsWith("--"))) ||
      (args.includes("--collect-preflight") &&
        (!collectKey || collectKey.startsWith("--") || !execute || reconcileOnly || journalPath)) ||
      (args.includes("--ceremony-reference") &&
        (!collectKey || !ceremonyReference || ceremonyReference.startsWith("--")))
    )
      throw new Error("Invalid multi-participant options.");
    const input = parseMultiGoldenInput(await Bun.file(inputPath).json());
    if (collectKey) {
      console.log(
        JSON.stringify(
          await collectMultiGoldenPreflight(input, collectKey, ceremonyReference),
          null,
          2,
        ),
      );
      return;
    }
    const result = await runMultiGolden(input, {
      execute,
      reconcileOnly,
      ...(journalPath ? { journalPath } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    if ("terminal" in result && result.terminal === false) process.exitCode = 2;
    return;
  }
  if (process.env.API_NEXT_ENV !== "staging") {
    throw new MegapotBaseSepoliaGoldenFailed(
      "invalid-options",
      "The golden flow is refused unless API_NEXT_ENV=staging.",
    );
  }
  const parsed = parseOptions(args);
  let document: unknown;
  try {
    document = JSON.parse(await Bun.file(parsed.input).text()) as unknown;
  } catch {
    throw new MegapotBaseSepoliaGoldenFailed("invalid-input", "Unable to read golden-flow input.");
  }
  let participantPreflight: MegapotParticipantPreflight | undefined;
  if (parsed.participantPreflight !== undefined) {
    try {
      participantPreflight = parseMegapotParticipantPreflight(
        JSON.parse(await Bun.file(parsed.participantPreflight).text()) as unknown,
      );
    } catch (error) {
      if (error instanceof MegapotBaseSepoliaGoldenFailed) throw error;
      throw new MegapotBaseSepoliaGoldenFailed(
        "invalid-input",
        "Unable to read participant preflight artifact.",
      );
    }
  }
  const result = await runMegapotBaseSepoliaGolden(parseMegapotGoldenInput(document), {
    execute: parsed.execute,
    qualifyStudy: parsed.qualifyStudy,
    apiOrigin: process.env.PIRATE_API_PUBLIC_ORIGIN ?? "https://api-next-staging.pirate.sc",
    ...(process.env.PIRATE_STAGING_AUTHORIZATION === undefined
      ? {}
      : { authorization: process.env.PIRATE_STAGING_AUTHORIZATION }),
    ...(process.env.PIRATE_STAGING_COOKIE === undefined
      ? {}
      : { cookie: process.env.PIRATE_STAGING_COOKIE }),
    ...(process.env.PIRATE_STAGING_CSRF_TOKEN === undefined
      ? {}
      : { csrfToken: process.env.PIRATE_STAGING_CSRF_TOKEN }),
    ...(process.env.PIRATE_STAGING_PARTICIPANT_AUTHORIZATION === undefined
      ? {}
      : { participantAuthorization: process.env.PIRATE_STAGING_PARTICIPANT_AUTHORIZATION }),
    ...(process.env.PIRATE_STAGING_PARTICIPANT_COOKIE === undefined
      ? {}
      : { participantCookie: process.env.PIRATE_STAGING_PARTICIPANT_COOKIE }),
    ...(process.env.PIRATE_STAGING_PARTICIPANT_CSRF_TOKEN === undefined
      ? {}
      : { participantCsrfToken: process.env.PIRATE_STAGING_PARTICIPANT_CSRF_TOKEN }),
    ...(participantPreflight === undefined ? {} : { participantPreflight }),
  });
  console.log(JSON.stringify(result, null, 2));
}
