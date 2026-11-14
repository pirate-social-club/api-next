import * as Domain from "@alchemy.run/domain";
export * from "./aggregate.ts";
import { Ceremony } from "./aggregate.ts";
import { ScheduleCeremony, ObserveCeremony } from "./automation.ts";
export class AdmissionModel extends Domain.Model("HnsAdmission", {
  aggregates: [Ceremony],
}) {}
export class OperationalModel extends Domain.Model("HnsAdmission", {
  aggregates: [Ceremony],
  policies: [ScheduleCeremony, ObserveCeremony],
}) {}
