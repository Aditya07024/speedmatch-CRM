import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "./logger";

export const SESSION_COOKIE = "speedmatch_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

let secret = process.env.SESSION_SECRET;
if (!secret) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production (see .env.example).");
  }
  secret = randomBytes(32).toString("hex");
  logger.warn(
    "SESSION_SECRET is not set - using a temporary secret. Sessions will reset when the server restarts.",
  );
}
const SECRET: string = secret;

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  // Always run a scrypt to keep timing similar for unknown users.
  const [scheme, salt, hash] = (stored ?? "scrypt$dummy$dummy").split("$");
  const candidate = scryptSync(password, salt ?? "dummy", 64);
  if (!stored || scheme !== "scrypt" || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

export function startSession(req: Request, res: Response, memberId: number): void {
  const payload = Buffer.from(
    JSON.stringify({ sub: memberId, exp: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  res.cookie(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function endSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Returns the signed-in member id from the session cookie, or null. */
export function getSessionMemberId(req: Request): number | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "number" || typeof data.exp !== "number" || data.exp < Date.now()) {
      return null;
    }
    return data.sub;
  } catch {
    return null;
  }
}
