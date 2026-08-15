// GENERATED FILE. DO NOT EDIT.
export interface PirateApiClient {
  get_health: (input?: unknown) => Promise<unknown>;
}

export function createPirateApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): PirateApiClient {
  const request = async (method: string, path: string, input: unknown) => {
    const response = await fetchImpl(new URL(path, baseUrl), { method, headers: { "content-type": "application/json" }, body: input === undefined ? undefined : JSON.stringify(input) });
    if (!response.ok) throw await response.json();
    return response.json();
  };
  return {
    "get_health": (input = undefined) => request("GET", "/health", input),
  };
}

