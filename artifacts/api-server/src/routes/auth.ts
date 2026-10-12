import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { db, teamMembersTable } from "@workspace/db";
import { createMember } from "../lib/speedmatch-auth";
import {
  endSession,
  hashPassword,
  startSession,
  verifyPassword,
} from "../lib/session";

const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/auth/sign-up", async (req, res): Promise<void> => {
  const name = String(req.body?.name ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const initiationCode = String(req.body?.initiationCode ?? req.body?.initiation_code ?? "").trim();

  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const [existing] = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(sql`lower(${teamMembersTable.email}) = ${email}`)
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const result = await createMember({
    email,
    name: name || email.split("@")[0] || "New member",
    passwordHash: hashPassword(password),
    initiationCode,
  });

  if (result.error || !result.member) {
    res.status(400).json({ error: result.error ?? "Could not create your account" });
    return;
  }

  startSession(req, res, result.member.id);
  res.status(201).json({ ok: true, status: result.member.status, role: result.member.role });
});

router.post("/auth/sign-in", async (req, res): Promise<void> => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const [member] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.email, email))
    .limit(1);
  if (!member || !verifyPassword(password, member.passwordHash)) {
    res.status(401).json({ error: "Incorrect email or password" });
    return;
  }
  startSession(req, res, member.id);
  res.json({ ok: true, status: member.status });
});

router.post("/auth/sign-out", (_req, res): void => {
  endSession(res);
  res.status(204).end();
});

export default router;
