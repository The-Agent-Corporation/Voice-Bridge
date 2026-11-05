/**
 * The `voice.md` format a folder's own agent writes, and the checker that holds it to MISSION.md:
 * the four sections, a size the voice agent can load into its prompt, and no secrets.
 */

export const VOICE_MD_FILE = "voice.md";

export const VOICE_MD_SECTIONS = ["What this is", "Status now", "Waiting on you", "Ask the agent about"] as const;

export const VOICE_MD_MAX_TOKENS = 1500;

export type VoiceMdProblemCode =
  | "missing_name"
  | "missing_updated"
  | "invalid_updated"
  | "missing_updated_by"
  | "missing_section"
  | "duplicate_section"
  | "empty_section"
  | "over_token_cap"
  | "secret";

export interface VoiceMdProblem {
  code: VoiceMdProblemCode;
  /** 1-based; null when the problem belongs to the whole file. */
  line: number | null;
  message: string;
}

export interface VoiceMdCheck {
  ok: boolean;
  problems: VoiceMdProblem[];
  tokens: number;
  words: number;
}

interface SecretRule {
  label: string;
  pattern: RegExp;
}

/**
 * Detection only: a match is reported by label and line, never echoed, because checker output lands in logs.
 * Every UUID counts as a session id: the checker runs offline, so it cannot tell a live session's id from
 * any other, and a spoken briefing has no use for one.
 */
const SECRET_RULES: readonly SecretRule[] = [
  { label: "api key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: "bearer token", pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { label: "credential in URL", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  {
    label: "credential assignment",
    pattern:
      /\b(password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|token|client[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s"']{4,})/i,
  },
  // A generated token with no telling prefix, such as the bridge's own client token: a long base64url run
  // mixing upper case, lower case and digits, which prose, paths and hex digests do not.
  { label: "high-entropy token", pattern: /(?<![\w-])(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=[\w-]*\d)[\w-]{32,}/ },
  { label: "session id", pattern: /\bsession[_ -]?id\s*[:=]\s*\S+/i },
  { label: "session id (UUID)", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Characters / 4, the project's one token estimate; no provider's tokenizer is chosen yet. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normaliseHeading(heading: string): string {
  return heading.trim().replace(/\s+/g, " ").toLowerCase();
}

function headerLabel(line: string, label: string): string | undefined {
  const match = new RegExp(`^${label}\\s*:(.*)$`, "i").exec(line.trim());
  return match ? match[1]!.trim() : undefined;
}

export function checkVoiceMd(raw: string): VoiceMdCheck {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const problems: VoiceMdProblem[] = [];

  let inFence = false;
  let inHeader = true;
  let nameSeen = false;
  let updatedSeen = false;
  let updatedBySeen = false;
  const sectionLines = new Map<string, number>();
  let openSection: { name: string; line: number; filled: boolean } | undefined;

  const requiredSections = new Set(VOICE_MD_SECTIONS.map(normaliseHeading));

  const closeSection = () => {
    if (openSection && !openSection.filled) {
      problems.push({ code: "empty_section", line: openSection.line, message: `section "${openSection.name}" is empty` });
    }
    openSection = undefined;
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        problems.push({ code: "secret", line: lineNo, message: `line contains a ${rule.label}; remove it` });
      }
    }

    const trimmedStart = line.trimStart();
    if (trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~")) {
      inFence = !inFence;
      if (openSection) openSection.filled = true;
      return;
    }
    const heading = inFence ? undefined : /^(#{1,2}) (.*)$/.exec(line);

    if (inHeader && !heading?.[1]?.startsWith("##")) {
      if (!nameSeen && line.trim()) {
        nameSeen = true;
        if (/^# +\S/.test(line)) return;
        problems.push({ code: "missing_name", line: lineNo, message: 'the first line must be "# <name>"' });
      }
      const updated = headerLabel(line, "updated");
      if (updated !== undefined) {
        updatedSeen = true;
        if (!TIMESTAMP.test(updated) || Number.isNaN(Date.parse(updated))) {
          problems.push({
            code: "invalid_updated",
            line: lineNo,
            message: "Updated must be an ISO 8601 time with a zone, such as 2026-11-05T14:30:00Z",
          });
        }
      }
      if (headerLabel(line, "updated by")) updatedBySeen = true;
      return;
    }

    if (!heading) {
      if (openSection && line.trim()) openSection.filled = true;
      return;
    }
    inHeader = false;
    closeSection();
    if (heading[1] !== "##") return;
    const key = normaliseHeading(heading[2]!);
    if (!requiredSections.has(key)) return;
    if (sectionLines.has(key)) {
      problems.push({ code: "duplicate_section", line: lineNo, message: `section "${heading[2]!.trim()}" appears more than once` });
    } else {
      sectionLines.set(key, lineNo);
    }
    openSection = { name: heading[2]!.trim(), line: lineNo, filled: false };
  });
  closeSection();

  if (!nameSeen) problems.push({ code: "missing_name", line: null, message: 'the file must start with "# <name>"' });
  if (!updatedSeen) problems.push({ code: "missing_updated", line: null, message: 'the header needs an "Updated: <time>" line' });
  if (!updatedBySeen) {
    problems.push({ code: "missing_updated_by", line: null, message: 'the header needs an "Updated by: <who>" line' });
  }
  for (const section of VOICE_MD_SECTIONS) {
    if (!sectionLines.has(normaliseHeading(section))) {
      problems.push({ code: "missing_section", line: null, message: `missing section "## ${section}"` });
    }
  }
  const tokens = estimateTokens(text);
  if (tokens > VOICE_MD_MAX_TOKENS) {
    problems.push({
      code: "over_token_cap",
      line: null,
      message: `about ${tokens} tokens, over the cap of ${VOICE_MD_MAX_TOKENS}`,
    });
  }

  problems.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER));
  return { ok: problems.length === 0, problems, tokens, words: text.match(/\S+/g)?.length ?? 0 };
}
