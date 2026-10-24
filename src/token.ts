import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const TOKEN_FILE = "client-token";

export function tokenPath(dataDir: string): string {
  return path.join(dataDir, TOKEN_FILE);
}

/** Creates the client token on first start (never overwriting one), then reads it back. */
export function ensureClientToken(dataDir: string): string {
  try {
    writeFileSync(tokenPath(dataDir), randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readClientToken(dataDir);
}

export function readClientToken(dataDir: string): string {
  const file = tokenPath(dataDir);
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    throw new BridgeError("insecure_token_file", `${file} is readable by other users; set its mode to 0600`);
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new BridgeError("empty_token_file", `${file} is empty`);
  return token;
}

/** Hashing first gives timingSafeEqual equal-length inputs, so length leaks nothing either. */
export function tokenMatches(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}
