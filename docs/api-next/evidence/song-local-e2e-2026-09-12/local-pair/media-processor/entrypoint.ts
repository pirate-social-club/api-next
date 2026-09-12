// Local budget guard for the fixture journey. Counts billable provider
// requests, logs each one as JSON, and refuses any request over the hard cap.
// The caps allow one retry per provider stage and stop the workflow with
// evidence instead of spending beyond the authorized budget.
const budgets = {
  "acrcloud.com": 2,
  "api.openai.com": 3,
  "openrouter.ai": 1,
  "api.elevenlabs.io": 1,
};
const counts = {};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let host = "";
  try {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    host = url.hostname;
  } catch {
    host = "";
  }
  const provider = Object.keys(budgets).find(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (provider !== undefined) {
    counts[provider] = (counts[provider] ?? 0) + 1;
    console.log(JSON.stringify({
      event: "provider-request",
      provider,
      host,
      count: counts[provider],
      budget: budgets[provider],
    }));
    if (counts[provider] > budgets[provider]) {
      console.log(JSON.stringify({
        event: "provider-budget-exhausted",
        provider,
        count: counts[provider],
        budget: budgets[provider],
      }));
      throw new Error(`provider budget exhausted: ${provider}`);
    }
  }
  return originalFetch(input, init);
};
const entry = await import("../../../apps/media-processor-worker/src/entrypoint.ts");
export default entry.default;
export const MediaProcessingWorkflow = entry.MediaProcessingWorkflow;
export const DanceReferenceProcessingWorkflow = entry.DanceReferenceProcessingWorkflow;
export const VideoAnalysisWorkflow = entry.VideoAnalysisWorkflow;
