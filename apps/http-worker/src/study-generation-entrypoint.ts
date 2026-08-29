import { makeCloudflareStudyGenerationWorkflowEntrypoint } from "@pirate/platform-cf/study-generation-workflow-entrypoint";
import {
  makeStudyGenerationWorkflowComposition,
  type StudyGenerationRuntimeEnv,
} from "./study-generation-production-composition.ts";
import {
  makeStudyGenerationWorkflowRunner,
  type StudyGenerationWorkflowPayload,
  type StudyGenerationWorkflowResult,
  type StudyGenerationWorkflowStep,
} from "./study-generation-workflow.ts";

const runner = makeStudyGenerationWorkflowRunner(makeStudyGenerationWorkflowComposition);
const CloudflareStudyGenerationWorkflow = makeCloudflareStudyGenerationWorkflowEntrypoint<
  StudyGenerationRuntimeEnv,
  StudyGenerationWorkflowPayload,
  StudyGenerationWorkflowResult,
  StudyGenerationWorkflowStep
>(runner);

/** Concrete disabled-first Workflow registered under this fixed class name. */
export class StudyGenerationWorkflow extends CloudflareStudyGenerationWorkflow {}
