import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, teamMembersTable } from "@workspace/db";
import { createMember, ensureSuperAdminExists } from "../lib/speedmatch-auth";
import {
  endSession,
  getSessionMemberId,
  hashPassword,
  startSession,
  verifyPassword,
} from "../lib/session";
import { addActivity } from "../lib/speedmatch-utils";

const router: IRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public auth configuration (Clerk publishable key)
router.get("/auth/config", (_req, res): void => {
  const publishableKey =
    process.env.VITE_CLERK_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
    process.env.CLERK_PUBLISHABLE_KEY ||
    "";
  res.json({ publishableKey });
});

// Clerk Sign-in Synchronization & Authorization Gate
router.post("/auth/clerk-sync", async (req, res): Promise<void> => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const name = String(req.body?.name ?? "").trim();
  const clerkId = String(req.body?.clerkId ?? "").trim();
  const avatarUrl = String(req.body?.avatarUrl ?? "").trim();

  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }
  if (!clerkId) {
    res.status(400).json({ error: "Clerk user ID is required" });
    return;
  }

  // Check if member already exists in team database
  const [existing] = await db
    .select()
    .from(teamMembersTable)
    .where(sql`lower(${teamMembersTable.email}) = ${email}`)
    .limit(1);

  if (existing) {
    // Update authId and avatar if needed
    const updates: Partial<typeof teamMembersTable.$inferInsert> = {
      authId: clerkId,
    };
    if (avatarUrl && !existing.avatarUrl) updates.avatarUrl = avatarUrl;
    if (name && (!existing.name || existing.name === existing.email.split("@")[0])) updates.name = name;

    await db
      .update(teamMembersTable)
      .set(updates)
      .where(eq(teamMembersTable.id, existing.id));

    startSession(req, res, existing.id);

    // If pre-assigned by Super Admin or Admin as active:
    if (existing.status === "active") {
      res.json({
        ok: true,
        status: existing.status,
        role: existing.role,
        member: {
          id: existing.id,
          email: existing.email,
          name: existing.name,
          role: existing.role,
          status: existing.status,
        },
      });
      return;
    }

    // Existing but pending approval:
    res.json({
      ok: false,
      status: "pending",
      role: existing.role,
      requiresSuperAdminApproval: true,
      requestMessage: existing.requestMessage,
      member: {
        id: existing.id,
        email: existing.email,
        name: existing.name,
        role: existing.role,
        status: existing.status,
      },
    });
    return;
  }

  // User does NOT exist in database (self-registered on Clerk)
  // Access control rule: "no one can create a dashboard by themself"
  const [created] = await db
    .insert(teamMembersTable)
    .values({
      authId: clerkId,
      email,
      name: name || email.split("@")[0],
      role: "member",
      status: "pending",
      avatarUrl: avatarUrl || null,
      requestMessage: null,
    })
    .returning();

  if (created) {
    startSession(req, res, created.id);
  }

  res.json({
    ok: false,
    status: "pending",
    role: "member",
    requiresSuperAdminApproval: true,
    message: "To login in this platform notify superadmin",
    member: created
      ? {
          id: created.id,
          email: created.email,
          name: created.name,
          role: created.role,
          status: created.status,
        }
      : null,
  });
});

// Submit custom message to Super Admin requesting access
router.post("/auth/request-access", async (req, res): Promise<void> => {
  const memberId = getSessionMemberId(req);
  if (!memberId) {
    res.status(401).json({ error: "Sign in first to notify Super Admin" });
    return;
  }

  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "Please enter a message for the Super Admin" });
    return;
  }

  const [member] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.id, memberId))
    .limit(1);

  if (!member) {
    res.status(404).json({ error: "User account not found" });
    return;
  }

  await db
    .update(teamMembersTable)
    .set({ requestMessage: message, status: "pending" })
    .where(eq(teamMembersTable.id, member.id));

  await addActivity(
    "access_request",
    "Access requested by user",
    `${member.name} (${member.email}): "${message}"`,
  );

  res.json({
    ok: true,
    message: "Notification sent to Super Admin. You will be able to access your dashboard once approved.",
  });
});

// Dedicated Super Admin Password Access
router.post("/auth/super-admin-login", async (req, res): Promise<void> => {
  try {
    await ensureSuperAdminExists().catch(() => {});

    const superAdminEmail = (
      process.env.SUPERADMIN_EMAIL || "superadmin@speedmatch.com"
    ).toLowerCase();
    const email = String(req.body?.email || superAdminEmail).trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const masterPassword =
      process.env.SUPERADMIN_PASSWORD || "SpeedMatchSuper2026!";

    // Check against database super_admin
    let [superAdminUser] = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.role, "super_admin"))
      .limit(1);

    if (!superAdminUser) {
      await ensureSuperAdminExists().catch(() => {});
      [superAdminUser] = await db
        .select()
        .from(teamMembersTable)
        .where(eq(teamMembersTable.role, "super_admin"))
        .limit(1);
    }

    const isMasterPassword = password === masterPassword;
    const isHashValid =
      superAdminUser?.passwordHash &&
      verifyPassword(password, superAdminUser.passwordHash);

    if (isMasterPassword || (isHashValid && (email === superAdminEmail || email === superAdminUser?.email))) {
      if (superAdminUser) {
        startSession(req, res, superAdminUser.id);
        res.json({
          ok: true,
          status: "active",
          role: "super_admin",
          member: {
            id: superAdminUser.id,
            email: superAdminUser.email,
            name: superAdminUser.name,
            role: "super_admin",
            status: "active",
          },
        });
        return;
      }
    }

    res.status(401).json({ error: "Invalid Super Admin credentials" });
  } catch (err) {
    res.status(500).json({ error: "Internal error during Super Admin authentication" });
  }
});

router.post("/auth/sign-out", (_req, res): void => {
  endSession(res);
  res.status(204).end();
});

export default router;
