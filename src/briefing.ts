import type { Project } from "./store.js";

export interface Briefing {
  freshness: "unverified";
  last_confirmed_activity: null;
  text: string;
}

/**
 * The bridge has no event source yet (saved sessions are not activity), so every briefing is
 * unverified and reports no confirmed activity rather than guessing at what an agent is doing.
 */
export function buildBriefing(project: Pick<Project, "project_id" | "display_name">): Briefing {
  return {
    freshness: "unverified",
    last_confirmed_activity: null,
    text:
      `${project.display_name} (${project.project_id}). ` +
      "No confirmed activity has been recorded for this project yet. Freshness: unverified. " +
      "The bridge has not observed any events for it.",
  };
}
