import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  communityPostsTable,
  companiesTable,
  db,
  invitationsTable,
  teamMembersTable,
  workspaceSettingsTable,
} from "@workspace/db";
import { getSessionMemberId, hashPassword } from "./session";

export type SpeedmatchMember = typeof teamMembersTable.$inferSelect;

async function currentMember(req: Request): Promise<SpeedmatchMember | null> {
  const memberId = getSessionMemberId(req);
  if (!memberId) return null;
  const [member] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.id, memberId))
    .limit(1);
  return member ?? null;
}

export async function ensureGlobalSettings(): Promise<string> {
  const [existing] = await db
    .select()
    .from(workspaceSettingsTable)
    .limit(1);
  if (existing) {
    return existing.initiationCode;
  }
  const [created] = await db
    .insert(workspaceSettingsTable)
    .values({ initiationCode: "SPEEDMATCH2026" })
    .returning();
  return created?.initiationCode ?? "SPEEDMATCH2026";
}

export async function ensureSuperAdminExists(): Promise<void> {
  try {
    await ensureGlobalSettings().catch(() => {});
    const superAdminEmail = (
      process.env.SUPERADMIN_EMAIL || "superadmin@speedmatch.com"
    ).toLowerCase().trim();
    const superAdminPassword =
      process.env.SUPERADMIN_PASSWORD || "SpeedMatchSuper2026!";

    const [existingSuper] = await db
      .select({ id: teamMembersTable.id, email: teamMembersTable.email })
      .from(teamMembersTable)
      .where(eq(teamMembersTable.role, "super_admin"))
      .limit(1);

    if (existingSuper) {
      await db
        .update(teamMembersTable)
        .set({
          passwordHash: hashPassword(superAdminPassword),
          status: "active",
        })
        .where(eq(teamMembersTable.id, existingSuper.id));
      return;
    }

    const [existingByEmail] = await db
      .select({ id: teamMembersTable.id })
      .from(teamMembersTable)
      .where(sql`lower(${teamMembersTable.email}) = ${superAdminEmail}`)
      .limit(1);

    if (existingByEmail) {
      await db
        .update(teamMembersTable)
        .set({
          role: "super_admin",
          status: "active",
          passwordHash: hashPassword(superAdminPassword),
        })
        .where(eq(teamMembersTable.id, existingByEmail.id));
    } else {
      await db.insert(teamMembersTable).values({
        authId: randomUUID(),
        email: superAdminEmail,
        name: "Super Admin",
        passwordHash: hashPassword(superAdminPassword),
        role: "super_admin",
        status: "active",
      });
    }
  } catch (err) {
    console.error("ensureSuperAdminExists error:", err);
  }
}

/**
 * Creates a new account.
 * Requires a valid initiation code provided by an admin.
 */
export async function createMember(input: {
  email: string;
  name: string;
  passwordHash: string;
  initiationCode?: string;
}): Promise<{ member: SpeedmatchMember | null; error?: string }> {
  const normalizedEmail = input.email.toLowerCase();
  const code = (input.initiationCode ?? "").trim();

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(74382017)`);

    const [countResult] = await tx
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(teamMembersTable);
    const isFirstMember = Number(countResult?.count ?? 0) === 0;

    // Verify initiation code
    let matchedCompanyId: number | null = null;
    let codeValid = isFirstMember;

    if (!codeValid && code) {
      // Check company initiation code
      const [company] = await tx
        .select()
        .from(companiesTable)
        .where(sql`lower(${companiesTable.initiationCode}) = ${code.toLowerCase()}`)
        .limit(1);
      if (company) {
        codeValid = true;
        matchedCompanyId = company.id;
      } else {
        // Check global workspace initiation code
        const [settings] = await tx
          .select()
          .from(workspaceSettingsTable)
          .limit(1);
        const globalCode = settings?.initiationCode ?? "SPEEDMATCH2026";
        if (globalCode.toLowerCase() === code.toLowerCase()) {
          codeValid = true;
        }
      }
    }

    if (!codeValid) {
      return {
        member: null,
        error: "Invalid initiation code. Registration requires a valid initiation code provided by an admin.",
      };
    }

    const [invitation] = await tx
      .select()
      .from(invitationsTable)
      .where(
        and(
          sql`lower(${invitationsTable.email}) = ${normalizedEmail}`,
          eq(invitationsTable.status, "pending"),
        ),
      )
      .orderBy(invitationsTable.createdAt)
      .limit(1);

    const [created] = await tx
      .insert(teamMembersTable)
      .values({
        authId: randomUUID(),
        email: normalizedEmail,
        name: input.name,
        passwordHash: input.passwordHash,
        role: isFirstMember ? "admin" : invitation?.role ?? "member",
        companyId: matchedCompanyId,
        status: "active",
      })
      .returning();

    if (invitation) {
      await tx
        .update(invitationsTable)
        .set({ status: "accepted" })
        .where(eq(invitationsTable.id, invitation.id));
    }
    if (isFirstMember && created) {
      await tx.insert(communityPostsTable).values({
        authorId: created.id,
        title: "Welcome to SpeedMatch",
        body:
          "A shared space for startup teams to exchange lessons, ask for advice, and make useful connections. Introduce yourself and tell the community what you are building.",
        category: "Introductions",
      });
    }
    return { member: created ?? null };
  });
}

export async function requireAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!getSessionMemberId(req)) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  next();
}

export async function requireActiveMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const member = await currentMember(req);
    if (!member) {
      res.status(401).json({ error: "Sign in to continue" });
      return;
    }
    if (member.status !== "active") {
      res.status(403).json({
        error:
          member.status === "rejected"
            ? "Your request to join this workspace was not approved"
            : "Your request is waiting for admin approval",
        status: member.status,
      });
      return;
    }
    res.locals.speedmatchMember = member;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Could not resolve SpeedMatch membership");
    res.status(403).json({
      error:
        error instanceof Error
          ? error.message
          : "Could not verify SpeedMatch membership",
    });
  }
}

export function requireAdmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const member = res.locals.speedmatchMember as SpeedmatchMember | undefined;
  if (!member || (member.role !== "admin" && member.role !== "super_admin")) {
    res.status(403).json({ error: "Admin access is required" });
    return;
  }
  next();
}

export function requireSuperAdmin(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const member = res.locals.speedmatchMember as SpeedmatchMember | undefined;
  if (!member || member.role !== "super_admin") {
    res.status(403).json({ error: "Super Admin access is required" });
    return;
  }
  next();
}

export async function resolveCurrentMember(
  req: Request,
): Promise<SpeedmatchMember | null> {
  return currentMember(req);
}

export function getRequestMember(res: Response): SpeedmatchMember {
  return res.locals.speedmatchMember as SpeedmatchMember;
}