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
  project_id_conflict: 400,
  path_already_registered: 400,
  invalid_request: 400,
  unauthorized: 401,
  unknown_tool: 404,
  project_not_found: 404,
  not_found: 404,
  method_not_allowed: 405,
  request_too_large: 413,
  internal_error: 500,
  git_failed: 500,
  session_discovery_failed: 500,
  build_id_unavailable: 503,
  store_version_unsupported: 500,
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
