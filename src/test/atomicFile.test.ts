import assert from "node:assert/strict";
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { writeFileAtomic } from "../atomicFile.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

function readFd(fd: number): string {
  const buffer = Buffer.alloc(1024);
  return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
}

test("a reader holding the old file still sees all of it after the replacement, and the path gives the new text", () => {
  const dir = tempDir();
  const file = path.join(dir, "VOICE.md");
  writeFileSync(file, "old briefing\n");
  const fd = openSync(file, "r");
  try {
    writeFileAtomic(file, "new briefing\n", { mode: 0o600 });
    assert.equal(readFd(fd), "old briefing\n");
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(file, "utf8"), "new briefing\n");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["VOICE.md"]);
});

test("a write that cannot finish leaves the old content in place", { skip: process.getuid?.() === 0 }, () => {
  const dir = tempDir();
  const file = path.join(dir, "VOICE.md");
  writeFileSync(file, "old briefing\n");
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => writeFileAtomic(file, "new briefing\n"));
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(readFileSync(file, "utf8"), "old briefing\n");
  assert.deepEqual(readdirSync(dir), ["VOICE.md"]);
});

test("a failed rename removes its temp file", () => {
  const dir = tempDir();
  const target = path.join(dir, "VOICE.md");
  mkdirSync(target);
  writeFileSync(path.join(target, "keep"), "x");
  assert.throws(() => writeFileAtomic(target, "new briefing\n"));
  assert.deepEqual(readdirSync(dir), ["VOICE.md"]);
  assert.deepEqual(readdirSync(target), ["keep"]);
});
