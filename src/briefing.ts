import type { ProjectStatus } from "./status.js";
import type { Project } from "./store.js";

export interface Briefing {
  freshness: ProjectStatus["freshness"];
  last_confirmed_activity: ProjectStatus["last_confirmed_activity"];
  text: string;
}

/** The text uses only fixed-vocabulary status fields, never an event's payload. */
export function buildBriefing(project: Pick<Project, "project_id" | "display_name">, status: ProjectStatus): Briefing {
  const activity = status.last_confirmed_activity;
  const reasons = status.freshness_reasons.length > 0 ? ` (${status.freshness_reasons.join(", ")})` : "";
  const text = activity
    ? `${project.display_name} (${project.project_id}). ` +
      `Last confirmed activity: ${activity.type} at ${activity.observed_at}. Freshness: ${status.freshness}${reasons}.`
    : `${project.display_name} (${project.project_id}). ` +
      `No confirmed activity has been recorded for this project yet. Freshness: ${status.freshness}${reasons}. ` +
      "The bridge has not processed any events for it.";
  return { freshness: status.freshness, last_confirmed_activity: activity, text };
}
