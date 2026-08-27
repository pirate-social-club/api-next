import type { DataRegistrationWorkflowResult } from "@pirate/application/data/registration-workflow";
import { makeCloudflareDataRegistrationWorkflowEntrypoint } from "@pirate/platform-cf/data/registration-workflow-entrypoint";
import { type DataRegistrationRuntimeEnv, makeDataRegistrationComposition } from "./composition.ts";
import {
  type DataRegistrationWorkflowStep,
  makeDataRegistrationQueueWorker,
  makeDataRegistrationWorkflowRunner,
} from "./index.ts";

const runner = makeDataRegistrationWorkflowRunner(makeDataRegistrationComposition);
const CloudflareDataRegistrationWorkflow = makeCloudflareDataRegistrationWorkflowEntrypoint<
  DataRegistrationRuntimeEnv,
  DataRegistrationWorkflowResult,
  DataRegistrationWorkflowStep
>(runner);

/** Concrete durable interpreter registered by Wrangler under a fixed class name. */
export class DataRegistrationWorkflow extends CloudflareDataRegistrationWorkflow {}

export default makeDataRegistrationQueueWorker(makeDataRegistrationComposition);
