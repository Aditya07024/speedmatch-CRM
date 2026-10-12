import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import {
  companiesTable,
  db,
  teamMembersTable,
} from "@workspace/db";
import { hashPassword } from "../../lib/session";
import {
  requireActiveMember,
  requireSuperAdmin,
} from "../../lib/speedmatch-auth";
import { addActivity, asIso } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

router.use("/superadmin", requireActiveMember, requireSuperAdmin);

// GET /api/superadmin/companies - List all companies with admin details
router.get("/superadmin/companies", async (_req, res): Promise<void> => {
  const companies = await db.select().from(companiesTable).orderBy(companiesTable.name);
  
  const results = await Promise.all(
    companies.map(async (comp) => {
      const [admin] = await db
        .select({ id: teamMembersTable.id, name: teamMembersTable.name, email: teamMembersTable.email })
        .from(teamMembersTable)
        .where(eq(teamMembersTable.companyId, comp.id))
        .limit(1);

      const [memberCountRes] = await db
        .select({ count: count() })
        .from(teamMembersTable)
        .where(eq(teamMembersTable.companyId, comp.id));

      return {
        ...comp,
        createdAt: asIso(comp.createdAt),
        adminName: admin?.name ?? "No Admin",
        adminEmail: comp.adminEmail || admin?.email || "No Admin Email",
        memberCount: memberCountRes?.count ?? 0,
      };
    })
  );

  res.json(results);
});

// POST /api/superadmin/companies - Create company & Assign Admin account
router.post("/superadmin/companies", async (req, res): Promise<void> => {
  const name = String(req.body?.name ?? "").trim();
  const adminName = String(req.body?.adminName ?? "").trim();
  const adminEmail = String(req.body?.adminEmail ?? "").trim().toLowerCase();
  const industry = String(req.body?.industry ?? "Software").trim();
  const website = String(req.body?.website ?? "").trim();
  const size = String(req.body?.size ?? "1-10").trim();

  if (!name) {
    res.status(400).json({ error: "Company name is required" });
    return;
  }
  if (!adminEmail || !adminEmail.includes("@")) {
    res.status(400).json({ error: "Valid Admin Email is required" });
    return;
  }

  // Insert company
  const [company] = await db
    .insert(companiesTable)
    .values({
      name,
      industry,
      website,
      size,
      status: "Active",
      adminEmail,
    })
    .returning();

  // Check if admin user already exists
  const [existingUser] = await db
    .select({ id: teamMembersTable.id, name: teamMembersTable.name })
    .from(teamMembersTable)
    .where(sql`lower(${teamMembersTable.email}) = ${adminEmail}`)
    .limit(1);

  let adminUser;
  if (existingUser) {
    [adminUser] = await db
      .update(teamMembersTable)
      .set({
        name: adminName || existingUser.name,
        role: "admin",
        status: "active",
        companyId: company.id,
      })
      .where(eq(teamMembersTable.id, existingUser.id))
      .returning();
  } else {
    [adminUser] = await db
      .insert(teamMembersTable)
      .values({
        authId: randomUUID(),
        name: adminName || `${name} Admin`,
        email: adminEmail,
        role: "admin",
        status: "active",
        companyId: company.id,
      })
      .returning();
  }

  await addActivity("company", "New company workspace created & Admin assigned", `${name} (${adminEmail})`);

  res.status(201).json({
    company: {
      ...company,
      createdAt: asIso(company.createdAt),
      adminName: adminUser.name,
      adminEmail: adminUser.email,
    },
  });
});

// PUT /api/superadmin/companies/:id/initiation-code - Update initiation code for company
router.put("/superadmin/companies/:id/initiation-code", async (req, res): Promise<void> => {
  const companyId = Number(req.params.id);
  const initiationCode = String(req.body?.initiationCode ?? "").trim();
  if (!companyId || isNaN(companyId)) {
    res.status(400).json({ error: "Invalid company ID" });
    return;
  }
  if (!initiationCode) {
    res.status(400).json({ error: "Initiation code cannot be empty" });
    return;
  }

  const [company] = await db
    .update(companiesTable)
    .set({ initiationCode })
    .where(eq(companiesTable.id, companyId))
    .returning();

  if (!company) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  await addActivity("company", "Company initiation code updated", `${company.name} -> ${initiationCode}`);

  res.json({ company: { ...company, createdAt: asIso(company.createdAt) } });
});

// POST /api/superadmin/companies/:id/reset-admin-password - Reset password for company admin
router.post("/superadmin/companies/:id/reset-admin-password", async (req, res): Promise<void> => {
  const companyId = Number(req.params.id);
  const newPassword = String(req.body?.newPassword ?? "").trim();
  if (!companyId || isNaN(companyId)) {
    res.status(400).json({ error: "Invalid company ID" });
    return;
  }
  if (!newPassword || newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  // Find admin for company
  const [admin] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.companyId, companyId))
    .limit(1);

  if (!admin) {
    res.status(404).json({ error: "No admin user found for this company" });
    return;
  }

  await db
    .update(teamMembersTable)
    .set({ passwordHash: hashPassword(newPassword) })
    .where(eq(teamMembersTable.id, admin.id));

  await addActivity("team", "Admin password reset", admin.email);

  res.json({ ok: true, message: `Password reset successfully for ${admin.email}` });
});

// DELETE /api/superadmin/companies/:id - Delete company
router.delete("/superadmin/companies/:id", async (req, res): Promise<void> => {
  const companyId = Number(req.params.id);
  if (!companyId || isNaN(companyId)) {
    res.status(400).json({ error: "Invalid company ID" });
    return;
  }

  // Delete team members belonging to this company
  await db.delete(teamMembersTable).where(eq(teamMembersTable.companyId, companyId));

  const [deletedCompany] = await db
    .delete(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .returning();

  if (!deletedCompany) {
    res.status(404).json({ error: "Company not found" });
    return;
  }

  await addActivity("company", "Company workspace deleted", deletedCompany.name);

  res.status(204).end();
});

// GET /api/superadmin/all-users - List all registered users (approved admins, employees, pending)
router.get("/superadmin/all-users", async (_req, res): Promise<void> => {
  // Ensure any active admin without a company gets a company created
  const orphanAdmins = await db
    .select()
    .from(teamMembersTable)
    .where(and(eq(teamMembersTable.role, "admin"), eq(teamMembersTable.status, "active"), sql`${teamMembersTable.companyId} IS NULL`));

  for (const admin of orphanAdmins) {
    const compName = `${admin.name.trim() || admin.email.split("@")[0]}'s Workspace`;
    const [comp] = await db
      .insert(companiesTable)
      .values({
        name: compName,
        adminEmail: admin.email,
        owner: admin.name,
      })
      .returning();
    if (comp) {
      await db
        .update(teamMembersTable)
        .set({ companyId: comp.id })
        .where(eq(teamMembersTable.id, admin.id));
    }
  }

  const users = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      email: teamMembersTable.email,
      role: teamMembersTable.role,
      status: teamMembersTable.status,
      companyId: teamMembersTable.companyId,
      companyName: companiesTable.name,
      requestMessage: teamMembersTable.requestMessage,
      joinedAt: teamMembersTable.joinedAt,
      avatarUrl: teamMembersTable.avatarUrl,
    })
    .from(teamMembersTable)
    .leftJoin(companiesTable, eq(teamMembersTable.companyId, companiesTable.id))
    .where(ne(teamMembersTable.role, "super_admin"))
    .orderBy(desc(teamMembersTable.joinedAt));

  res.json(users.map(u => ({ ...u, joinedAt: asIso(u.joinedAt) })));
});

// PATCH /api/superadmin/users/:id - Update user role, status, or company
router.patch("/superadmin/users/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const { role, status, companyId } = req.body ?? {};
  const updates: Partial<typeof teamMembersTable.$inferInsert> = {};

  if (role && (role === "admin" || role === "member")) updates.role = role;
  if (status && (status === "active" || status === "pending" || status === "rejected")) updates.status = status;
  if (companyId !== undefined) updates.companyId = companyId ? Number(companyId) : null;

  const [updated] = await db
    .update(teamMembersTable)
    .set(updates)
    .where(eq(teamMembersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await addActivity("team", `Updated access for ${updated.name}`, `${updated.email} (${updated.role}, ${updated.status})`);
  res.json({ ok: true, member: updated });
});

// DELETE /api/superadmin/users/:id - Delete / remove user account
router.delete("/superadmin/users/:id", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [deleted] = await db
    .delete(teamMembersTable)
    .where(and(eq(teamMembersTable.id, id), ne(teamMembersTable.role, "super_admin")))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "User not found or cannot delete super admin" });
    return;
  }

  await addActivity("team", `Removed user access`, deleted.email);
  res.status(204).end();
});

// GET /api/superadmin/pending-requests - List all users pending approval with custom messages
router.get("/superadmin/pending-requests", async (_req, res): Promise<void> => {
  const requests = await db
    .select({
      id: teamMembersTable.id,
      name: teamMembersTable.name,
      email: teamMembersTable.email,
      role: teamMembersTable.role,
      status: teamMembersTable.status,
      requestMessage: teamMembersTable.requestMessage,
      joinedAt: teamMembersTable.joinedAt,
      avatarUrl: teamMembersTable.avatarUrl,
    })
    .from(teamMembersTable)
    .where(eq(teamMembersTable.status, "pending"))
    .orderBy(desc(teamMembersTable.joinedAt));

  res.json(requests.map(r => ({ ...r, joinedAt: asIso(r.joinedAt) })));
});

// POST /api/superadmin/requests/:id/approve-admin - Approve pending request as Admin
router.post("/superadmin/requests/:id/approve-admin", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [member] = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.id, id))
    .limit(1);

  if (!member) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  let companyId = member.companyId;
  if (!companyId) {
    const compName = `${member.name.trim() || member.email.split("@")[0]}'s Workspace`;
    const [comp] = await db
      .insert(companiesTable)
      .values({
        name: compName,
        adminEmail: member.email,
        owner: member.name,
      })
      .returning();
    if (comp) companyId = comp.id;
  }

  const [updated] = await db
    .update(teamMembersTable)
    .set({
      role: "admin",
      status: "active",
      companyId: companyId ?? null,
    })
    .where(eq(teamMembersTable.id, id))
    .returning();

  await addActivity("team", "Approved user as Workspace Admin", updated.email);
  res.json({ ok: true, member: updated });
});

// POST /api/superadmin/requests/:id/approve-employee - Approve pending request as Employee
router.post("/superadmin/requests/:id/approve-employee", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [updated] = await db
    .update(teamMembersTable)
    .set({ role: "member", status: "active" })
    .where(eq(teamMembersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  await addActivity("team", "Approved user as Employee", updated.email);
  res.json({ ok: true, member: updated });
});

// POST /api/superadmin/requests/:id/reject - Reject pending request
router.post("/superadmin/requests/:id/reject", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const [updated] = await db
    .update(teamMembersTable)
    .set({ status: "rejected" })
    .where(eq(teamMembersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  await addActivity("team", "Rejected user access", updated.email);
  res.json({ ok: true, member: updated });
});

// POST /api/superadmin/assign-admin - Directly assign any email as an Admin
router.post("/superadmin/assign-admin", async (req, res): Promise<void> => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const name = String(req.body?.name ?? "").trim();
  const companyId = req.body?.companyId ? Number(req.body.companyId) : null;

  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(teamMembersTable)
    .where(sql`lower(${teamMembersTable.email}) = ${email}`)
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(teamMembersTable)
      .set({
        role: "admin",
        status: "active",
        companyId: companyId ?? existing.companyId,
        name: name || existing.name,
      })
      .where(eq(teamMembersTable.id, existing.id))
      .returning();

    await addActivity("team", "Assigned user as Admin", email);
    res.json({ ok: true, member: updated });
    return;
  }

  const [created] = await db
    .insert(teamMembersTable)
    .values({
      authId: randomUUID(),
      email,
      name: name || email.split("@")[0],
      role: "admin",
      status: "active",
      companyId: companyId,
    })
    .returning();

  await addActivity("team", "Pre-assigned email as Admin", email);
  res.status(201).json({ ok: true, member: created });
});

export default router;
