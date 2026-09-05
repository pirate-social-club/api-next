/** Local destructive test admission only; never a staging/provider target resolver. */
export function localRecoveryTestUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      url.username.length === 0 ||
      url.pathname !== "/postgres" ||
      url.hash !== "" ||
      [...url.searchParams].some(([key, value]) => key !== "sslmode" || value !== "disable")
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new Error("local_recovery_test_target_required");
  }
}
