import { CommunityCreationRepositoryError } from "../../ports.ts";

export class CommunityOwnerSetupError extends CommunityCreationRepositoryError {
  constructor(readonly explanation: string) {
    super({ operation: "commit", reason: "constraint" });
    this.message = explanation;
  }
}
