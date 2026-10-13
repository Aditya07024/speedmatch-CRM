import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  companiesTable,
  db,
  invitationsTable,
  teamMembersTable,
} from "@workspace/db";
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

  // Check if email is assigned as company admin
  const [assignedCompany] = await db
    .select()
    .from(companiesTable)
    .where(sql`lower(trim(${companiesTable.adminEmail})) = ${email}`)
    .limit(1);

  // Check if email has pending invitation from an admin
  const [invitation] = await db
    .select()
    .from(invitationsTable)
    .where(and(sql`lower(trim(${invitationsTable.email})) = ${email}`, eq(invitationsTable.status, "pending")))
    .limit(1);

  // Check if member already exists in team database
  const [existing] = await db
    .select()
    .from(teamMembersTable)
    .where(sql`lower(trim(${teamMembersTable.email})) = ${email}`)
    .limit(1);

  if (existing) {
    const updates: Partial<typeof teamMembersTable.$inferInsert> = {
      authId: clerkId,
    };
    if (avatarUrl && !existing.avatarUrl) updates.avatarUrl = avatarUrl;
    if (name && (!existing.name || existing.name === existing.email.split("@")[0])) updates.name = name;

    // If pre-assigned as company admin, or already an admin, or invited by a teammate, activate immediately!
    if (assignedCompany) {
      updates.role = "admin";
      updates.status = "active";
      if (!existing.companyId) updates.companyId = assignedCompany.id;
    } else if (existing.role === "admin") {
      updates.role = "admin";
      updates.status = "active";
      if (!existing.companyId) {
        const compName = `${(existing.name || name).trim() || email.split("@")[0]}'s Workspace`;
        const [comp] = await db
          .insert(companiesTable)
          .values({
            name: compName,
            adminEmail: email,
            owner: existing.name || name,
          })
          .returning();
        if (comp) updates.companyId = comp.id;
      }
    } else if (existing.status === "active") {
      updates.status = "active";
    } else if (invitation) {
      updates.role = invitation.role || "member";
      updates.status = "active";
      await db.update(invitationsTable).set({ status: "accepted" }).where(eq(invitationsTable.id, invitation.id));
    }

    const [updated] = await db
      .update(teamMembersTable)
      .set(updates)
      .where(eq(teamMembersTable.id, existing.id))
      .returning();

    const current = updated || existing;
    startSession(req, res, current.id);

    if (current.status === "active") {
      res.json({
        ok: true,
        status: current.status,
        role: current.role,
        member: {
          id: current.id,
          email: current.email,
          name: current.name,
          role: current.role,
          status: current.status,
          companyId: current.companyId,
        },
      });
      return;
    }

    // Existing but pending approval:
    res.json({
      ok: false,
      status: "pending",
      role: current.role,
      requiresSuperAdminApproval: true,
      requestMessage: current.requestMessage,
      member: {
        id: current.id,
        email: current.email,
        name: current.name,
        role: current.role,
        status: current.status,
        companyId: current.companyId,
      },
    });
    return;
  }

  // User does NOT exist in database (self-registered on Clerk)
  let initialRole = "member";
  let initialStatus = "pending";
  let initialCompanyId: number | null = null;

  if (assignedCompany) {
    initialRole = "admin";
    initialStatus = "active";
    initialCompanyId = assignedCompany.id;
  } else if (invitation) {
    initialRole = invitation.role || "member";
    initialStatus = "active";
    await db.update(invitationsTable).set({ status: "accepted" }).where(eq(invitationsTable.id, invitation.id));
  }

  const [created] = await db
    .insert(teamMembersTable)
    .values({
      authId: clerkId,
      email,
      name: name || email.split("@")[0],
      role: initialRole,
      status: initialStatus,
      companyId: initialCompanyId,
      avatarUrl: avatarUrl || null,
      requestMessage: null,
    })
    .returning();

  if (created) {
    startSession(req, res, created.id);
  }

  res.json({
    ok: initialStatus === "active",
    status: initialStatus,
    role: initialRole,
    requiresSuperAdminApproval: initialStatus !== "active",
    message: initialStatus === "active" ? "Welcome" : "To login in this platform notify superadmin",
    member: created
      ? {
          id: created.id,
          email: created.email,
          name: created.name,
          role: created.role,
          status: created.status,
          companyId: created.companyId,
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
