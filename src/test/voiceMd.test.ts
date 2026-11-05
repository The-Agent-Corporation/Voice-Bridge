import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { checkVoiceMd, VOICE_MD_SECTIONS, type VoiceMdProblemCode } from "../voiceMd.js";

const VALID_VOICE_MD = `# Roscoe
Updated: 2026-11-05T14:30:00Z
Updated by: roscoe-main

## What this is
The billing service for the shop, and the agent that maintains it.

## Status now
Invoices for October went out. The retry job is being rewritten.

## Waiting on you
Nothing right now.

## Ask the agent about
- the retry job rewrite
- why two invoices were sent twice last week
`;

const codes = (text: string): VoiceMdProblemCode[] => checkVoiceMd(text).problems.map((p) => p.code);

/** Replaces the body of "Status now" with `body`; the body starts on line 9. */
const withStatus = (body: string) =>
  VALID_VOICE_MD.replace("Invoices for October went out. The retry job is being rewritten.", body);

test("the template passes with its size counted", () => {
  const result = checkVoiceMd(VALID_VOICE_MD);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.ok(result.tokens > 0);
  assert.ok(result.words > 0);
});

test("each missing section is reported by name", () => {
  for (const section of VOICE_MD_SECTIONS) {
    const text = VALID_VOICE_MD.replace(`## ${section}\n`, "");
    const { problems } = checkVoiceMd(text);
    assert.equal(problems.length, 1, section);
    assert.equal(problems[0]!.code, "missing_section", section);
    assert.match(problems[0]!.message, new RegExp(section), section);
  }
});

test("a heading inside a fenced block or at level three does not count", () => {
  for (const fence of ["```", "~~~"]) {
    const fenced = VALID_VOICE_MD.replace("## Status now\n", `${fence}\n## Status now\n${fence}\n`);
    assert.deepEqual(codes(fenced), ["missing_section"], fence);
  }
  assert.deepEqual(codes(VALID_VOICE_MD.replace("## Status now", "### Status now")), ["missing_section"]);
});

test("empty and duplicated sections are rejected; case and spacing are not", () => {
  const empty = VALID_VOICE_MD.replace("Nothing right now.\n", "\n");
  assert.deepEqual(checkVoiceMd(empty).problems.map((p) => [p.code, p.line]), [["empty_section", 11]]);

  const duplicated = `${VALID_VOICE_MD}\n## Status now\nAgain.\n`;
  assert.deepEqual(codes(duplicated), ["duplicate_section"]);

  assert.deepEqual(codes(VALID_VOICE_MD.replace("## Status now", "##  status NOW ")), []);
});

test("other sections are not checked, even empty or repeated", () => {
  assert.deepEqual(codes(`${VALID_VOICE_MD}\n## Notes\n\n## Notes\nMore.\n`), []);
  const emptyAfterExtra = VALID_VOICE_MD.replace("## Waiting on you\nNothing right now.\n", "## Notes\nSome.\n\n## Waiting on you\n");
  assert.deepEqual(codes(emptyAfterExtra), ["empty_section"]);
});

test("each header line is required and the time must be a real zoned timestamp", () => {
  assert.deepEqual(codes(VALID_VOICE_MD.replace("# Roscoe\n", "Roscoe\n")), ["missing_name"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("# Roscoe\n", "")), ["missing_name"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("Updated: 2026-11-05T14:30:00Z\n", "")), ["missing_updated"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("2026-11-05T14:30:00Z", "yesterday")), ["invalid_updated"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("2026-11-05T14:30:00Z", "2026-11-05T14:30:00")), ["invalid_updated"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("2026-11-05T14:30:00Z", "2026-13-45T14:30:00Z")), ["invalid_updated"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("2026-11-05T14:30:00Z", "2026-11-05T14:30+02:00")), []);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("Updated by: roscoe-main\n", "")), ["missing_updated_by"]);
  assert.deepEqual(codes(VALID_VOICE_MD.replace("Updated by: roscoe-main\n", "Updated by:\n")), ["missing_updated_by"]);
});

test("the size cap is 1,500 tokens at four characters each", () => {
  const padded = (length: number) => VALID_VOICE_MD + "x".repeat(length - VALID_VOICE_MD.length);
  const atCap = checkVoiceMd(padded(6000));
  assert.deepEqual(atCap.problems, []);
  assert.equal(atCap.tokens, 1500);

  const over = checkVoiceMd(padded(6001));
  assert.deepEqual(over.problems.map((p) => p.code), ["over_token_cap"]);
  assert.match(over.problems[0]!.message, /1501.*1500/);
});

test("every kind of secret is reported by line without echoing it", () => {
  // Built from pieces so no scanner mistakes this file for one holding real credentials.
  const samples: [label: string, sample: string][] = [
    ["api key", "sk-" + "ant-api03-abcdefghijklmnopqrstuv"],
    ["GitHub token", "gh" + "p_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"],
    ["GitHub token", "github" + "_pat_" + "11ABCDEFG0123456789_abcdefghij"],
    ["AWS access key", "AK" + "IA" + "ABCDEFGHIJKLMNOP"],
    ["Slack token", "xo" + "xb-" + "1234567890-abcdefghij"],
    ["private key", "-----BEGIN RSA " + "PRIVATE KEY-----"],
    ["JSON web token", "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["bearer token", "send Bearer " + "abcdefghijklmnop1234"],
    ["credential in URL", "clone https://fred:" + "hunter22@example.com/repo"],
    ["credential assignment", "password = " + "correcthorse"],
    ["credential assignment", "API_KEY: " + "'abcd1234efgh'"],
    ["credential assignment", "password: " + '"correct horse battery staple"'],
    ["credential assignment", "password=" + "hunter2"],
    ["credential assignment", "token: " + randomBytes(32).toString("base64url")],
    ["credential assignment", "client-token = " + "s3cr3tvalue"],
    ["high-entropy token", "rotate " + "Zq7vK2mXw9" + "Lp4Rt8Yb1Nc6Hd3Fg5Js0Ae"],
    ["session id", "session_id: " + "abc123"],
    ["session id (UUID)", "resume 019a3c1e-7b2f-" + "7c40-9e1d-2f3a4b5c6d7e"],
  ];
  for (const [label, sample] of samples) {
    const { problems } = checkVoiceMd(withStatus(sample));
    const secrets = problems.filter((p) => p.code === "secret");
    assert.ok(secrets.length > 0, label);
    assert.ok(secrets.every((p) => p.line === 9), label);
    assert.ok(secrets.some((p) => p.message.includes(label)), label);
    for (const p of problems) assert.ok(!p.message.includes(sample), label);
  }

  const fenced = checkVoiceMd(withStatus("```\n" + "password=" + "correcthorse\n```"));
  assert.deepEqual(fenced.problems.map((p) => [p.code, p.line]), [["secret", 10]]);
});

test("ordinary words about credentials and sessions are not secrets", () => {
  for (const line of [
    "password: see the vault",
    "api key rotation is due",
    "the session went quiet at 2026-11-05T14:30:00Z",
    "Bearer of bad news",
    "token: see the vault",
    "see https://github.com/The-Agent-Corporation/Voice-Bridge/pull/123",
    "commit 0abb74c4f543406481bea49c6e3b82cff7e3e2d6",
  ]) {
    assert.deepEqual(codes(withStatus(line)), [], line);
  }
});

test("a file saved on Windows with a byte-order mark passes", () => {
  assert.deepEqual(codes("\uFEFF" + VALID_VOICE_MD.replace(/\n/g, "\r\n")), []);
});

test("every problem is reported at once, ordered by line with whole-file problems last", () => {
  const text = withStatus("password=" + "correcthorse")
    .replace("2026-11-05T14:30:00Z", "soon")
    .replace("## Waiting on you\n", "");
  const { problems } = checkVoiceMd(text);
  assert.deepEqual(
    problems.map((p) => [p.code, p.line]),
    [
      ["invalid_updated", 2],
      ["secret", 9],
      ["missing_section", null],
    ],
  );
});
