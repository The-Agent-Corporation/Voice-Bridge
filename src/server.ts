import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProviderHomes } from "./adapters/homes.js";
import { refreshBriefing } from "./briefingFile.js";
import { BridgeError, requireString } from "./errors.js";
import { ingestEvent } from "./events.js";
import { dismissInboxQuestion, listInbox } from "./inbox.js";
import { cancelMessage, getMessage, sendToPrimary } from "./messages.js";
import { getPrimarySession, pinPrimary, unpinPrimary } from "./primary.js";
import { listProjects, openProject, registerProject } from "./registry.js";
import { listSessions } from "./sessions.js";
import { getProjectStatus } from "./status.js";
import type { Store } from "./store.js";
import { tokenMatches } from "./token.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface BridgeServerOptions {
  store: Store;
  token: string;
  buildId: string | null;
  providerHomes: ProviderHomes;
}

type Tool = (options: BridgeServerOptions, body: Record<string, unknown>) => unknown;

const TOOLS: Record<string, Tool> = {
  register_project: ({ store, providerHomes }, body) => registerProject(store, requireString(body, "path"), providerHomes),
  list_projects: ({ store }) => ({ projects: listProjects(store) }),
  open_project: ({ store }, body) => openProject(store, requireString(body, "project_id")),
  list_sessions: ({ store, providerHomes }, body) => listSessions(store, requireString(body, "project_id"), providerHomes),
  get_primary_session: ({ store, providerHomes }, body) =>
    getPrimarySession(store, requireString(body, "project_id"), providerHomes),
  pin_primary: ({ store, providerHomes }, body) =>
    pinPrimary(store, requireString(body, "project_id"), requireString(body, "session_id"), providerHomes),
  unpin_primary: ({ store, providerHomes }, body) => unpinPrimary(store, requireString(body, "project_id"), providerHomes),
  ingest_event: ({ store }, body) => {
    const result = ingestEvent(store, body);
    // A duplicate refreshes too: the content hash, not the duplicate flag, decides whether the file is rewritten.
    // The event is already committed, so a failed refresh is logged rather than reported as a failed ingest.
    const projectId = requireString(body, "project_id");
    let failure: unknown;
    try {
      const briefing = refreshBriefing(store, projectId);
      if (briefing.write === "failed") failure = briefing.error;
    } catch (error) {
      failure = error instanceof Error ? error.message : error;
    }
    if (failure !== undefined) console.error(`voice-bridge: VOICE.md not written for ${projectId}: ${failure}`);
    return result;
  },
  get_project_status: ({ store }, body) => getProjectStatus(store, requireString(body, "project_id")),
  list_inbox: ({ store }, body) => listInbox(store, body),
  dismiss_inbox_question: ({ store }, body) => dismissInboxQuestion(store, body),
  send_to_primary: ({ store, providerHomes }, body) => sendToPrimary(store, body, providerHomes),
  get_message: ({ store }, body) => getMessage(store, body),
  cancel_message: ({ store }, body) => cancelMessage(store, body),
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, error: BridgeError): void {
  sendJson(res, error.status, { error: { code: error.code, message: error.message } });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match !== null && tokenMatches(match[1]!, token);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BridgeError("request_too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BridgeError("invalid_request", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BridgeError("invalid_request", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function requireMethod(req: IncomingMessage, method: string): void {
  if (req.method !== method) {
    throw new BridgeError("method_not_allowed", `${req.method} is not allowed here; use ${method}`);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, options: BridgeServerOptions): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");

  if (pathname === "/health") {
    requireMethod(req, "GET");
    return sendJson(res, 200, { status: "ok" });
  }

  if (pathname === "/build-id") {
    requireMethod(req, "GET");
    if (options.buildId === null) {
      throw new BridgeError("build_id_unavailable", "FACTORY_RUNTIME_CANDIDATE is unset and git rev-parse HEAD failed");
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(options.buildId);
    return;
  }

  if (pathname.startsWith("/tools/")) {
    // Auth comes first so an unauthenticated caller learns nothing, not even which tools exist.
    if (!isAuthorized(req, options.token)) {
      throw new BridgeError("unauthorized", "missing or invalid bearer token");
    }
    requireMethod(req, "POST");
    const name = pathname.slice("/tools/".length);
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (!tool) throw new BridgeError("unknown_tool", `no tool named ${name}`);
    const body = await readJsonObject(req);
    return sendJson(res, 200, await tool(options, body));
  }

  throw new BridgeError("not_found", `nothing is served at ${pathname}`);
}

export function createBridgeServer(options: BridgeServerOptions): Server {
  return createServer((req, res) => {
    route(req, res, options).catch((error: unknown) => {
      if (error instanceof BridgeError) return sendError(res, error);
      console.error("voice-bridge: internal error:", error);
      sendError(res, new BridgeError("internal_error", "internal error; see the daemon log"));
    });
  });
}
