// Ordinary contract is preserved; all R2 I/O is outside short SQL transactions.
import type {ControlPlaneDb,ControlPlaneError,LearnerAudioDeletionStore} from "@pirate/application";
import type {Layer} from "effect";
import {makeAccountLearnerAudioDeleteProtocol} from "./account-audio-deletion-protocol.ts";
import {makeAccountLearnerAudioDeletionIo} from "./owner-audio-deletion-io.ts";
export const LEARNER_AUDIO_DELETE_BATCH_LIMIT=1000;
export interface LearnerAudioDeletionBucket {delete:(keys:string|string[])=>Promise<void>}
export const makeControlPlaneLearnerAudioDeletionStore=(runtime:Layer.Layer<ControlPlaneDb,ControlPlaneError,never>,bucket:LearnerAudioDeletionBucket):LearnerAudioDeletionStore=>makeAccountLearnerAudioDeletionIo(makeAccountLearnerAudioDeleteProtocol(runtime),bucket);
