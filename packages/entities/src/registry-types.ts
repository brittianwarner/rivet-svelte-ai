import type { Registry } from "rivetkit";
import type { organization } from "./actors/organization.ts";
import type { project } from "./actors/project.ts";
import type { projectExport } from "./actors/project-export.ts";
import type { user } from "./actors/user.ts";

/**
 * The entity actors call each other by these names. Register them under the
 * same names: `setup({ use: { ...entityActors, yourActor } })`.
 */
export type EntityRegistry = Registry<{
  user: typeof user;
  organization: typeof organization;
  project: typeof project;
  projectExport: typeof projectExport;
}>;
