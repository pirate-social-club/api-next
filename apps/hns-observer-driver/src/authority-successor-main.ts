import { open } from "node:fs/promises";
import { runHnsAuthoritySuccessorEmitterV1 } from "./authority-successor-emitter.ts";

async function readBoundedFile(absolutePath: string, maximumBytes: number): Promise<Uint8Array> {
  const file = await open(absolutePath, "r");
  try {
    const retained = new Uint8Array(maximumBytes + 1);
    const { bytesRead } = await file.read(retained, 0, retained.byteLength, 0);
    return retained.slice(0, bytesRead);
  } finally {
    await file.close();
  }
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  await runHnsAuthoritySuccessorEmitterV1(args, {
    read: readBoundedFile,
    emit: async (candidateBytes) => {
      await Bun.write(Bun.stdout, candidateBytes);
    },
  });
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "HNS authority successor emission failed",
    );
    process.exitCode = 1;
  });
}
