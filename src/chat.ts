import { randomUUID } from "node:crypto";
import type { MessageReceipt } from "./messages.js";
import type { OpenedProject, ProjectSummary } from "./registry.js";
import type { MessageReason, MessageState } from "./store.js";

/**
 * The bridge's HTTP tools, called with the client token like any other client. The chat reaches
 * projects only through this, never through the store.
 */
export type CallTool = <T>(tool: string, body: Record<string, unknown>) => Promise<T>;

/** What the conversation remembers: one project's briefing at most, replaced on every switch. */
export interface ConversationContext {
  active_project_id: string | null;
  briefing: Pick<OpenedProject, "project_id" | "display_name" | "freshness" | "briefing"> | null;
}

type Command =
  | { kind: "list" }
  | { kind: "open"; name: string }
  | { kind: "happening" }
  | { kind: "tell"; instruction: string }
  | { kind: "unknown" };

const HELP = `I understand: list projects | open <name> | switch to <name> | what's happening? | tell it <instruction>`;

/** What each receipt state shows, and no more: only `started` and `completed` say the session acted on it. */
const STATE_WORDING: Record<MessageState, string> = {
  accepted: "accepted, not yet queued",
  queued: "queued, not yet delivered",
  delivering: "being handed to the session, not yet delivered",
  delivered: "delivered; the session has not reported starting it",
  acknowledged: "acknowledged by the session; it has not reported starting it",
  started: "started; the session reported a turn for it",
  completed: "completed; the session reported its turn finished",
  failed: "failed",
  expired: "expired before it was delivered",
  cancelled: "cancelled before it was delivered",
};

/** The reasons `send_to_primary` refuses for before anything is sent. */
const REFUSALS: ReadonlySet<MessageReason> = new Set(["ambiguous_owner", "not_controllable", "unsupported_capability"]);

type SendReceipt = MessageReceipt & { duplicate: boolean };

/** An instruction whose send threw, so the bridge may or may not hold it; resending it reuses its key. */
interface UnconfirmedSend {
  project_id: string;
  instruction: string;
  idempotency_key: string;
}

export function parseCommand(line: string): Command {
  const text = line.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  if (lower === "list projects") return { kind: "list" };
  if (/^what['\u2019]?s happening\??$/.test(lower)) return { kind: "happening" };
  const open = /^(?:open|switch to) (.+)$/i.exec(text);
  if (open) return { kind: "open", name: open[1]! };
  const tell = /^tell it (.+)$/i.exec(text);
  if (tell) return { kind: "tell", instruction: tell[1]! };
  return { kind: "unknown" };
}

/**
 * An exact id or display name wins; otherwise every project whose id or display name contains the
 * name is a candidate. Comparison ignores case.
 */
export function matchProjects(projects: readonly ProjectSummary[], name: string): ProjectSummary[] {
  const wanted = name.toLowerCase();
  const fields = (p: ProjectSummary) => [p.project_id.toLowerCase(), p.display_name.toLowerCase()];
  const exact = projects.filter((p) => fields(p).includes(wanted));
  if (exact.length > 0) return exact;
  return projects.filter((p) => fields(p).some((field) => field.includes(wanted)));
}

export function describeReceipt(receipt: SendReceipt): string {
  const wording = receipt.state === "failed" && REFUSALS.has(receipt.reason) ? "refused, not sent" : STATE_WORDING[receipt.state];
  const target = receipt.session_id ?? "no session";
  const already = receipt.duplicate ? "The bridge already had this instruction; " : "";
  return `${already}Message ${receipt.message_id} for ${target}: ${wording} (${receipt.reason}: ${receipt.detail}).`;
}

function heading(project: Pick<OpenedProject, "display_name" | "freshness">): string {
  return `${project.display_name} (freshness: ${project.freshness})`;
}

export class Conversation {
  #context: ConversationContext = { active_project_id: null, briefing: null };
  #unconfirmed: UnconfirmedSend | null = null;

  constructor(private readonly callTool: CallTool) {}

  get context(): ConversationContext {
    return structuredClone(this.#context);
  }

  /** Answers one line of input. Tool errors propagate and leave the context as it was. */
  async reply(line: string): Promise<string> {
    const command = parseCommand(line);
    switch (command.kind) {
      case "list":
        return this.#listProjects();
      case "open":
        return this.#open(command.name);
      case "happening":
        return this.#happening();
      case "tell":
        return this.#tell(command.instruction);
      case "unknown":
        return HELP;
    }
  }

  async #listProjects(): Promise<string> {
    const { projects } = await this.callTool<{ projects: ProjectSummary[] }>("list_projects", {});
    if (projects.length === 0) return "No projects are registered.";
    return projects.map((p) => `${p.project_id} (${p.display_name})`).join("\n");
  }

  async #open(name: string): Promise<string> {
    const { projects } = await this.callTool<{ projects: ProjectSummary[] }>("list_projects", {});
    const matches = matchProjects(projects, name);
    if (matches.length === 0) return `No project matches "${name}".`;
    if (matches.length > 1) {
      const candidates = matches.map((p) => `- ${p.project_id} (${p.display_name})`);
      return [`Several projects match "${name}"; say open with one of these ids:`, ...candidates].join("\n");
    }
    const project = await this.#load(matches[0]!.project_id);
    return `${heading(project)}\nOpened. Ask "what's happening?" for its briefing.`;
  }

  async #happening(): Promise<string> {
    if (this.#context.active_project_id === null) return `No project is open. ${HELP}`;
    const project = await this.#load(this.#context.active_project_id);
    return `${heading(project)}\n${project.briefing.trimEnd()}`;
  }

  /**
   * Repeating the last instruction after its send threw reuses that send's key, so the bridge answers
   * with the message it may already hold instead of storing a second one. Once a send returns, the
   * same words again are a new instruction.
   */
  async #tell(instruction: string): Promise<string> {
    const projectId = this.#context.active_project_id;
    if (projectId === null) return `No project is open, so nothing was sent. ${HELP}`;
    const pending = this.#unconfirmed;
    const send =
      pending?.project_id === projectId && pending.instruction === instruction
        ? pending
        : { project_id: projectId, instruction, idempotency_key: `chat-${randomUUID()}` };
    this.#unconfirmed = send;
    const receipt = await this.callTool<SendReceipt>("send_to_primary", {
      project_id: projectId,
      text: instruction,
      mode: "next_turn",
      idempotency_key: send.idempotency_key,
    });
    this.#unconfirmed = null;
    return describeReceipt(receipt);
  }

  /** Replaces the whole context, so the previous project's briefing is dropped rather than kept beside the new one. */
  async #load(projectId: string): Promise<OpenedProject> {
    const project = await this.callTool<OpenedProject>("open_project", { project_id: projectId });
    const { display_name, freshness, briefing } = project;
    this.#context = { active_project_id: project.project_id, briefing: { project_id: project.project_id, display_name, freshness, briefing } };
    return project;
  }
}
