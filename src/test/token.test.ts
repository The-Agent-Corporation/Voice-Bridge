import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { ensureClientToken, tokenMatches, tokenPath } from "../token.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

test("tokenMatches accepts only the exact token", () => {
  assert.equal(tokenMatches("secret-token", "secret-token"), true);
  assert.equal(tokenMatches("secret-toke", "secret-token"), false);
  assert.equal(tokenMatches("secret-token ", "secret-token"), false);
  assert.equal(tokenMatches("", "secret-token"), false);
});

test("ensureClientToken creates a 0600 token once and never overwrites it", () => {
  const dir = tempDir();
  const first = ensureClientToken(dir);
  assert.ok(first.length >= 32);
  if (process.platform !== "win32") assert.equal(statSync(tokenPath(dir)).mode & 0o777, 0o600);
  assert.equal(ensureClientToken(dir), first);
  assert.equal(readFileSync(tokenPath(dir), "utf8"), first);
});

test("ensureClientToken refuses a token file other users can read", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  ensureClientToken(dir);
  chmodSync(tokenPath(dir), 0o644);
  assert.throws(() => ensureClientToken(dir), { code: "insecure_token_file" });
});
