import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Writes a uniquely named temp file beside `file`, then renames it over `file`, so readers see old or new, never part. */
export function writeFileAtomic(file: string, text: string, options: { mode?: number } = {}): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", flush: true, mode: options.mode });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
