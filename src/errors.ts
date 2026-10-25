const STATUS_BY_CODE = {
  invalid_path: 400,
  path_not_found: 400,
  not_a_git_work_tree: 400,
  not_work_tree_root: 400,
  config_not_found: 400,
  config_invalid_json: 400,
  invalid_schema_version: 400,
  missing_project_id: 400,
  invalid_project_id: 400,
  missing_display_name: 400,
  invalid_allowed_providers: 400,
  invalid_briefing_file: 400,
  invalid_max_briefing_tokens: 400,
  project_id_conflict: 400,
  path_already_registered: 400,
  invalid_request: 400,
  session_not_in_project: 400,
  unsupported_provider: 400,
  provider_not_allowed: 400,
  unauthorized: 401,
  unknown_tool: 404,
  project_not_found: 404,
  inbox_question_not_found: 404,
  message_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  event_conflict: 409,
  idempotency_conflict: 409,
  workspace_owned: 409,
  unsupported_capability: 409,
  inbox_question_not_open: 409,
  no_origin_session: 409,
  request_too_large: 413,
  payload_too_large: 413,
  internal_error: 500,
  git_failed: 500,
  session_discovery_failed: 500,
  lease_lost: 500,
  provider_start_failed: 502,
  provider_not_installed: 503,
  build_id_unavailable: 503,
  bridge_closing: 503,
  store_version_unsupported: 500,
  invalid_reconcile_interval: 500,
  insecure_token_file: 500,
  empty_token_file: 500,
} as const;

export type ErrorCode = keyof typeof STATUS_BY_CODE;

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value) {
    throw new BridgeError("invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
