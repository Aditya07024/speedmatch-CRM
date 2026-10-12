import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
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

// POST /api/superadmin/companies - Create company & Admin account
router.post("/superadmin/companies", async (req, res): Promise<void> => {
  const name = String(req.body?.name ?? "").trim();
  const adminName = String(req.body?.adminName ?? "").trim();
  const adminEmail = String(req.body?.adminEmail ?? "").trim().toLowerCase();
  const adminPassword = String(req.body?.adminPassword ?? "").trim();
  const initiationCode = String(req.body?.initiationCode ?? req.body?.initiation_code ?? "").trim() || "SPEEDMATCH2026";
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
  if (!adminPassword || adminPassword.length < 8) {
    res.status(400).json({ error: "Admin Password must be at least 8 characters" });
    return;
  }

  // Check if admin email already exists
  const [existingEmail] = await db
    .select({ id: teamMembersTable.id })
    .from(teamMembersTable)
    .where(sql`lower(${teamMembersTable.email}) = ${adminEmail}`)
    .limit(1);
  if (existingEmail) {
    res.status(409).json({ error: "An account with this email already exists" });
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
      initiationCode,
      adminEmail,
    })
    .returning();

  // Create workspace admin user for this company
  const [adminUser] = await db
    .insert(teamMembersTable)
    .values({
      authId: randomUUID(),
      name: adminName || `${name} Admin`,
      email: adminEmail,
      passwordHash: hashPassword(adminPassword),
      role: "admin",
      status: "active",
      companyId: company.id,
    })
    .returning();

  await addActivity("company", "New company workspace created", `${name} (${initiationCode})`);

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

export default router;
