import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { readHead, runGit } from "../git.js";
import { commit, makeRepo, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

test("readHead reports no commit in a fresh repository, then the commit made", async () => {
  const repo = makeRepo();
  assert.deepEqual(await readHead(repo), { ok: true, head: null });
  const hash = commit(repo);
  assert.deepEqual(await readHead(repo), { ok: true, head: hash });
});

test("readHead outside a repository fails with git's reason", async () => {
  const read = await readHead(tempDir());
  assert.equal(read.ok, false);
  assert.match(!read.ok ? read.detail : "", /not a git repository/);
});

test("git is never run from a relative PATH entry, even one that holds a git", async () => {
  const bin = tempDir();
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = path.relative(process.cwd(), bin);
  try {
    assert.deepEqual(runGit(["--version"], tempDir()), {
      ok: false,
      notARepository: false,
      detail: "git was not found in any absolute PATH entry",
    });
    assert.deepEqual(await readHead(tempDir()), { ok: false, detail: "git was not found in any absolute PATH entry" });
  } finally {
    process.env.PATH = savedPath;
  }
});
