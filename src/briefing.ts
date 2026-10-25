import { PROVIDERS } from "./adapters/types.js";
import { getProjectStatus, latestRecordedCommit, type ProjectStatus } from "./status.js";
import { BRIEFING_EVENTS_PER_TYPE, type BriefingEventRow, type Store } from "./store.js";

/** The briefing's `## ` headings, in file order (docs/PRD.md §6.1). */
export const SECTION_HEADINGS = [
  "Project",
  "Current objective",
  "Agent and last confirmed status",
  "Latest progress and current task",
  "Blockers and pending questions",
  "Next steps",
  "Provenance",
] as const;

export interface BudgetLevel {
  objective: boolean;
  progressSummary: boolean;
  /** UTF-16 code units kept of each agent-reported field; 0 shows no agent-reported text at all. */
  fieldChars: number;
  steps: number;
  blockers: number;
  questions: number;
}

/**
 * Render levels tried in order until one fits the budget. Cuts follow reverse priority: the
 * objective goes first, then the latest progress, then every list and field shrinks, questions last.
 */
export const BUDGET_LEVELS: readonly BudgetLevel[] = [
  { objective: true, progressSummary: true, fieldChars: 280, steps: 5, blockers: 3, questions: 5 },
  { objective: false, progressSummary: true, fieldChars: 280, steps: 5, blockers: 3, questions: 5 },
  { objective: false, progressSummary: false, fieldChars: 280, steps: 5, blockers: 3, questions: 5 },
  { objective: false, progressSummary: false, fieldChars: 120, steps: 3, blockers: 2, questions: 3 },
  { objective: false, progressSummary: false, fieldChars: 60, steps: 1, blockers: 1, questions: 2 },
  { objective: false, progressSummary: false, fieldChars: 0, steps: 0, blockers: 0, questions: 5 },
];

const DISPLAY_NAME_CHARS = 80;
const OMITTED = "(omitted to fit the briefing budget)";
/** Shorter identifiers are left alone so a short test id cannot mangle ordinary words. */
const MIN_SCRUBBED_ID_LENGTH = 8;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abp]-[A-Za-z0-9-]+/g,
  // The whole key, not just its header: a redacted header would still leave the key body behind.
  /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
];

export interface BriefingState {
  project_id: string;
  display_name: string;
  status: Pick<ProjectStatus, "freshness" | "freshness_reasons" | "last_confirmed_activity">;
  /** Processed events of the briefing types, newest first. */
  events: readonly BriefingEventRow[];
  highest_event_id: number | null;
  /** Every session identifier known for the project; each is scrubbed from the text. */
  session_identifiers: readonly string[];
}

export function loadBriefingState(store: Store, project: { project_id: string; display_name: string }): BriefingState {
  const status = getProjectStatus(store, project.project_id);
  const events = store.recentBriefingEvents(project.project_id);
  const identifiers = new Set<string>();
  for (const session of store.listSessions(project.project_id)) {
    identifiers.add(session.session_id);
    identifiers.add(session.native_session_id);
  }
  for (const { session_id } of events) {
    if (session_id === null) continue;
    identifiers.add(session_id);
    const provider = providerOf(session_id);
    if (provider) identifiers.add(session_id.slice(provider.length + 1));
  }
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    status,
    events,
    highest_event_id: store.highestProcessedEventId(project.project_id),
    session_identifiers: [...identifiers].sort(),
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Collapses whitespace and control characters so the text stays on one line. */
export function oneLine(text: string): string {
  return text.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "[REDACTED]"), text);
}

/**
 * Renders the briefing at the first level of `BUDGET_LEVELS` that fits `maxTokens`. The same state
 * and options always give the same text.
 */
export function renderBriefing(state: BriefingState, options: { maxTokens: number; generatedAt: string }): string {
  const facts = collectFacts(state);
  for (const level of BUDGET_LEVELS) {
    const text = finalize(renderAt(state, facts, level, options.generatedAt), facts.scrub);
    if (estimateTokens(text) <= options.maxTokens) return text;
  }
  throw new Error(`the briefing for ${state.project_id} does not fit ${options.maxTokens} tokens even at its smallest`);
}

interface Dated {
  text: string;
  observed_at: string;
}

interface Question {
  id: string;
  summary: string;
}

/** What the renderer reads from the events, cleaned but not yet cut to a level's field length. */
interface Facts {
  scrub: (text: string) => string;
  displayName: string;
  objective: string | null;
  nextSteps: string[];
  progress: Dated | null;
  currentTask: string | null;
  blockers: Dated[];
  blockersAtCap: boolean;
  questions: Question[];
  questionsAtCap: boolean;
  agent: string;
  commit: string | null;
}

function providerOf(sessionId: string): string | undefined {
  return PROVIDERS.find((provider) => sessionId.startsWith(`${provider}:`));
}

function parseObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringField(payload: Record<string, unknown> | null, field: string): string | null {
  const value = payload?.[field];
  return typeof value === "string" ? value : null;
}

function collectFacts(state: BriefingState): Facts {
  const identifiers = state.session_identifiers
    .filter((id) => id.length >= MIN_SCRUBBED_ID_LENGTH)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const scrub = (text: string) =>
    identifiers.reduce((result, id) => result.split(id).join("[session]"), redactSecrets(text));
  // Collapsing whitespace keeps every field on one line, and escaping a leading `#` keeps it from
  // reading as a heading, so no payload can change the file's structure. Collapsing comes first so a
  // secret split by a newline or tab is still whole when it is redacted.
  const clean = (text: string) => scrub(oneLine(text)).replace(/^#/, "\\#");

  const parsed = state.events.map((event) => ({ ...event, fields: parseObject(event.payload) }));
  const ofType = (type: BriefingEventRow["type"]) => parsed.filter((event) => event.type === type);
  const newest = (type: BriefingEventRow["type"], field: string) => {
    for (const event of ofType(type)) {
      const value = stringField(event.fields, field);
      if (value !== null) return { text: clean(value), observed_at: event.observed_at };
    }
    return null;
  };

  const plan = ofType("plan_updated").find((event) => Array.isArray(event.fields?.next_steps));
  const steps = (plan?.fields?.next_steps ?? []) as unknown[];

  const blockerEvents = ofType("blocker");
  const questionEvents = ofType("user_question");

  const agentEvent = parsed.find((event) => event.type.startsWith("session_") || event.type.startsWith("turn_"));
  const agentProvider = agentEvent?.session_id ? providerOf(agentEvent.session_id) : undefined;

  return {
    scrub,
    displayName: truncate(clean(state.display_name), DISPLAY_NAME_CHARS),
    objective: newest("plan_updated", "objective")?.text ?? null,
    nextSteps: steps.filter((step): step is string => typeof step === "string").map(clean),
    progress: newest("progress", "summary"),
    currentTask: newest("progress", "current_task")?.text ?? null,
    blockers: blockerEvents.map((event) => ({
      text: clean(stringField(event.fields, "summary") ?? ""),
      observed_at: event.observed_at,
    })),
    blockersAtCap: blockerEvents.length >= BRIEFING_EVENTS_PER_TYPE,
    questions: pendingQuestions(questionEvents, ofType("user_decision"), clean),
    questionsAtCap: questionEvents.length >= BRIEFING_EVENTS_PER_TYPE,
    agent: agentProvider ?? "not identified",
    commit: latestRecordedCommit(state.events)?.commit ?? null,
  };
}

type ParsedEvent = BriefingEventRow & { fields: Record<string, unknown> | null };

/**
 * A question's identity is its session plus its origin `question_id`, or the event alone without one.
 * Its id is `q-<event_id>` of the identity's earliest event; its newest event supplies the summary
 * and can withdraw it, and a `user_decision` naming the id answers it. Newest first.
 */
function pendingQuestions(
  questions: readonly ParsedEvent[],
  decisions: readonly ParsedEvent[],
  clean: (text: string) => string,
): Question[] {
  const answered = new Set(decisions.map((event) => stringField(event.fields, "question_id")));
  const identities = new Map<string, { newest: ParsedEvent; earliestId: number }>();
  for (const event of questions) {
    const originId = stringField(event.fields, "question_id");
    const key = originId === null ? `event\0${event.event_id}` : `origin\0${event.session_id ?? ""}\0${originId}`;
    const known = identities.get(key);
    if (known) known.earliestId = Math.min(known.earliestId, event.event_id);
    else identities.set(key, { newest: event, earliestId: event.event_id });
  }
  return [...identities.values()]
    .filter(({ newest, earliestId }) => newest.fields?.withdrawn !== true && !answered.has(`q-${earliestId}`))
    .map(({ newest, earliestId }) => ({
      id: `q-${earliestId}`,
      summary: clean(stringField(newest.fields, "summary") ?? ""),
    }));
}

/**
 * Cuts to at most `limit` UTF-16 code units, the unit the token estimate counts, without splitting a
 * character, and marks the cut with `…`.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > limit - 1) break;
    kept += point;
  }
  return `${kept}…`;
}

function moreLine(hidden: number, atCap: boolean): string[] {
  if (hidden <= 0 && !atCap) return [];
  return [`(${atCap ? "at least " : ""}${hidden} more in the bridge store)`];
}

function renderAt(state: BriefingState, facts: Facts, level: BudgetLevel, generatedAt: string): string[] {
  const field = (text: string) => truncate(text, level.fieldChars);
  const labelled = (prefix: string, text: string) => (text ? `${prefix}: ${field(text)}` : prefix);
  const { status } = state;
  const activity = status.last_confirmed_activity;
  const reasons = status.freshness_reasons.length > 0 ? ` (${status.freshness_reasons.join(", ")})` : "";

  const objective = facts.objective === null ? "No objective has been reported." : level.objective ? field(facts.objective) : OMITTED;

  const currentTask = facts.currentTask === null ? "none reported" : level.fieldChars > 0 ? field(facts.currentTask) : OMITTED;
  const progress = facts.progress === null
    ? "Latest progress: No progress has been reported."
    : level.progressSummary
      ? `Latest progress (${facts.progress.observed_at}): ${field(facts.progress.text)}`
      : `Latest progress (${facts.progress.observed_at}): ${OMITTED}`;

  const blockers = facts.blockers.length === 0
    ? ["- none reported"]
    : level.blockers === 0
      ? [`- ${facts.blockers.length}${facts.blockersAtCap ? " or more" : ""} reported ${OMITTED}`]
      : [
          ...facts.blockers.slice(0, level.blockers).map((b) => `- ${labelled(`reported at ${b.observed_at}`, b.text)}`),
          ...moreLine(facts.blockers.length - level.blockers, facts.blockersAtCap),
        ];

  const questions = facts.questions.length === 0
    ? ["- none"]
    : [
        ...facts.questions
          .slice(0, level.questions)
          .map((q) => (level.fieldChars > 0 ? `- ${labelled(q.id, q.summary)}` : `- ${q.id}`)),
        ...moreLine(facts.questions.length - level.questions, facts.questionsAtCap),
      ];

  const steps = facts.nextSteps.length === 0
    ? ["None reported."]
    : level.steps === 0
      ? [`${facts.nextSteps.length} ${OMITTED}`]
      : [
          ...facts.nextSteps.slice(0, level.steps).map((step) => `- ${field(step)}`),
          ...moreLine(facts.nextSteps.length - level.steps, false),
        ];

  return [
    "<!-- Generated by VOICE Bridge from its local store. Edits here are overwritten. -->",
    "",
    "## Project",
    `${facts.displayName} (${state.project_id})`,
    "",
    "## Current objective",
    objective,
    "",
    "## Agent and last confirmed status",
    `Agent: ${facts.agent}`,
    activity
      ? `Last confirmed activity: ${activity.type} at ${activity.observed_at}. No newer event has been confirmed.`
      : "No confirmed activity has been recorded for this project yet.",
    "",
    "## Latest progress and current task",
    `Current task: ${currentTask}`,
    progress,
    "",
    "## Blockers and pending questions",
    "Blockers:",
    ...blockers,
    "Pending questions:",
    ...questions,
    "",
    "## Next steps",
    ...steps,
    "",
    "## Provenance",
    `Generated: ${generatedAt}`,
    `Highest reconciled event: ${state.highest_event_id ?? "none"}`,
    `Commit: ${facts.commit ?? "none recorded"}`,
    `Freshness: ${status.freshness}${reasons}`,
  ];
}

/**
 * A second redaction and scrub, line by line, backs up the per-field pass; the budget is measured after it.
 * Line by line, an unterminated private key is redacted to the end of its own line, never the rest of the file.
 */
function finalize(lines: string[], scrub: (text: string) => string): string {
  return `${lines.join("\n").split("\n").map(scrub).join("\n")}\n`;
}
