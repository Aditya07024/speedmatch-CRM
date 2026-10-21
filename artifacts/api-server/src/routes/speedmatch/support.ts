import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  companiesTable,
  db,
  supportTicketsTable,
  teamMembersTable,
} from "@workspace/db";
import { getRequestMember, requireActiveMember } from "../../lib/speedmatch-auth";
import { addActivity, asIso, parseRouteId } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

let tableEnsured = false;
async function ensureSupportTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS speedmatch_support_tickets (
        id SERIAL PRIMARY KEY,
        company_id INTEGER,
        user_id INTEGER NOT NULL REFERENCES speedmatch_team_members(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL DEFAULT '',
        user_email TEXT NOT NULL DEFAULT '',
        user_role TEXT NOT NULL DEFAULT 'member',
        company_name TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'Suggestion',
        priority TEXT NOT NULL DEFAULT 'Medium',
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Pending',
        admin_response TEXT,
        responded_at TIMESTAMP WITH TIME ZONE,
        responded_by TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    tableEnsured = true;
  } catch (err) {
    console.warn("Could not auto-verify support tickets table:", err);
  }
}

router.use("/support", requireActiveMember);

function formatTicket(ticket: typeof supportTicketsTable.$inferSelect) {
  return {
    ...ticket,
    respondedAt: ticket.respondedAt ? asIso(ticket.respondedAt) : null,
    createdAt: asIso(ticket.createdAt),
    updatedAt: asIso(ticket.updatedAt),
  };
}

// GET /api/support/tickets
// Superadmin sees all submitted tickets. Regular users see their own submitted tickets.
router.get("/support/tickets", async (req, res): Promise<void> => {
  await ensureSupportTable();
  const member = getRequestMember(res);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const type = typeof req.query.type === "string" ? req.query.type.trim() : "";

  try {
    const isSuperAdmin = member.role === "super_admin";
    const conditions = [];

    if (!isSuperAdmin) {
      conditions.push(eq(supportTicketsTable.userId, member.id));
    }

    if (status && status.toLowerCase() !== "all") {
      conditions.push(ilike(supportTicketsTable.status, status));
    }

    if (type && type.toLowerCase() !== "all") {
      conditions.push(ilike(supportTicketsTable.type, type));
    }

    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        or(
          ilike(supportTicketsTable.subject, pattern),
          ilike(supportTicketsTable.message, pattern),
          ilike(supportTicketsTable.userName, pattern),
          ilike(supportTicketsTable.userEmail, pattern),
          ilike(supportTicketsTable.companyName, pattern)
        )!
      );
    }

    const rows = await db
      .select()
      .from(supportTicketsTable)
      .where(conditions.length ? and(...conditions) : sql`true`)
      .orderBy(desc(supportTicketsTable.createdAt));

    res.json(rows.map(formatTicket));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load support tickets" });
  }
});

// POST /api/support/tickets
// Any active user can submit a suggestion, report, or feedback to super admin
router.post("/support/tickets", async (req, res): Promise<void> => {
  await ensureSupportTable();
  const member = getRequestMember(res);
  const {
    subject,
    message,
    type = "Suggestion",
    priority = "Medium",
  } = req.body || {};

  if (!subject || typeof subject !== "string" || !subject.trim()) {
    res.status(400).json({ error: "Subject is required" });
    return;
  }

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Message details are required" });
    return;
  }

  try {
    // Find company name if member has companyId
    let companyName = "Independent Workspace";
    if (member.companyId) {
      const [comp] = await db
        .select({ name: companiesTable.name })
        .from(companiesTable)
        .where(eq(companiesTable.id, member.companyId))
        .limit(1);
      if (comp?.name) companyName = comp.name;
    }

    const [created] = await db
      .insert(supportTicketsTable)
      .values({
        companyId: member.companyId ?? null,
        userId: member.id,
        userName: member.name || "User",
        userEmail: member.email || "",
        userRole: member.role || "member",
        companyName,
        type: typeof type === "string" ? type.trim() : "Suggestion",
        priority: typeof priority === "string" ? priority.trim() : "Medium",
        subject: subject.trim(),
        message: message.trim(),
        status: "Pending",
      })
      .returning();

    await addActivity(
      "support",
      `New ${created.type} from ${created.userName}`,
      `${created.subject} (${created.companyName})`
    ).catch(() => {});

    res.status(201).json(formatTicket(created));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to submit support ticket" });
  }
});

// PUT /api/support/tickets/:id
// Superadmin can update status, add response, and mark resolved
router.put("/support/tickets/:id", async (req, res): Promise<void> => {
  await ensureSupportTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    const isSuperAdmin = member.role === "super_admin";
    const isAuthor = existing.userId === member.id;

    if (!isSuperAdmin && !isAuthor) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const { status, adminResponse, priority } = req.body || {};
    const updates: Partial<typeof supportTicketsTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (isSuperAdmin) {
      if (status !== undefined) updates.status = String(status).trim();
      if (priority !== undefined) updates.priority = String(priority).trim();
      if (adminResponse !== undefined) {
        updates.adminResponse = String(adminResponse).trim();
        updates.respondedAt = new Date();
        updates.respondedBy = member.name || "Super Admin";
      }
    } else if (isAuthor) {
      // User can close their own ticket or update description
      if (status === "Closed") updates.status = "Closed";
    }

    const [updated] = await db
      .update(supportTicketsTable)
      .set(updates)
      .where(eq(supportTicketsTable.id, id))
      .returning();

    res.json(formatTicket(updated));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to update ticket" });
  }
});

// DELETE /api/support/tickets/:id
router.delete("/support/tickets/:id", async (req, res): Promise<void> => {
  await ensureSupportTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid ticket id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    const canDelete = member.role === "super_admin" || existing.userId === member.id;
    if (!canDelete) {
      res.status(403).json({ error: "You cannot delete this ticket" });
      return;
    }

    await db.delete(supportTicketsTable).where(eq(supportTicketsTable.id, id));
    res.json({ success: true, id });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to delete ticket" });
  }
});

export default router;
