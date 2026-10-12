import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  companiesTable,
  db,
  invitationsTable,
  teamMembersTable,
  workspaceSettingsTable,
} from "@workspace/db";
import {
  ApproveJoinRequestParams,
  ApproveJoinRequestResponse,
  CreateInvitationBody,
  CreateInvitationResponse,
  GetCurrentMemberResponse,
  ListJoinRequestsResponse,
  ListMembersResponse,
  RejectJoinRequestParams,
  RejectJoinRequestResponse,
} from "@workspace/api-zod";
import {
  getRequestMember,
  requireActiveMember,
  requireAdmin,
  requireAuthenticated,
  resolveCurrentMember,
} from "../../lib/speedmatch-auth";
import { addActivity, asIso, parseRouteId } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

function memberForResponse(
  member: typeof teamMembersTable.$inferSelect,
) {
  const { passwordHash: _passwordHash, ...safe } = member;
  return {
    ...safe,
    joinedAt: asIso(member.joinedAt),
  };
}

router.get("/team/me", requireAuthenticated, async (req, res): Promise<void> => {
  const member = await resolveCurrentMember(req);
  if (!member) {
    res.status(401).json({ error: "Sign in to continue" });
    return;
  }
  res.json(GetCurrentMemberResponse.parse(memberForResponse(member)));
});

router.use("/team", requireActiveMember);

router.get("/team/members", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(teamMembersTable)
    .where(eq(teamMembersTable.status, "active"))
    .orderBy(teamMembersTable.name);
  res.json(ListMembersResponse.parse(rows.map(memberForResponse)));
});

router.get(
  "/team/join-requests",
  requireAdmin,
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.status, "pending"))
      .orderBy(desc(teamMembersTable.joinedAt));
    res.json(ListJoinRequestsResponse.parse(rows.map(memberForResponse)));
  },
);

router.post(
  "/team/join-requests/:id/approve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ApproveJoinRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [member] = await db
      .update(teamMembersTable)
      .set({ status: "active" })
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.status, "pending"),
        ),
      )
      .returning();
    if (!member) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }
    await addActivity("team", "New teammate approved", member.name);
    res.json(
      ApproveJoinRequestResponse.parse(memberForResponse(member)),
    );
  },
);

router.post(
  "/team/join-requests/:id/reject",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = RejectJoinRequestParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [member] = await db
      .update(teamMembersTable)
      .set({ status: "rejected" })
      .where(
        and(
          eq(teamMembersTable.id, params.data.id),
          eq(teamMembersTable.status, "pending"),
        ),
      )
      .returning();
    if (!member) {
      res.status(404).json({ error: "Pending join request not found" });
      return;
    }
    await addActivity("team", "Join request declined", member.name);
    res.status(204).json(RejectJoinRequestResponse.parse(undefined));
  },
);

router.post(
  "/team/invitations",
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = CreateInvitationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const [member] = await db
      .select()
      .from(teamMembersTable)
      .where(sql`lower(${teamMembersTable.email}) = ${email}`)
      .limit(1);
    const [pendingInvite] = await db
      .select()
      .from(invitationsTable)
      .where(
        and(
          sql`lower(${invitationsTable.email}) = ${email}`,
          eq(invitationsTable.status, "pending"),
        ),
      )
      .limit(1);
    if (member?.status === "active" || pendingInvite) {
      res.status(409).json({ error: "This email already has workspace access or an invitation" });
      return;
    }

    const [invitation] = await db
      .insert(invitationsTable)
      .values({
        email,
        role: parsed.data.role ?? "member",
        status: "pending",
        invitedBy: getRequestMember(res).authId,
      })
      .returning();

    await addActivity("team", "Teammate invited", email);
    res
      .status(201)
      .json(CreateInvitationResponse.parse({
        ...invitation,
        createdAt: asIso(invitation.createdAt),
      }));
  },
);

router.get(
  "/team/initiation-code",
  requireAdmin,
  async (_req, res): Promise<void> => {
    const member = getRequestMember(res);
    let code = "SPEEDMATCH2026";
    if (member.companyId) {
      const [comp] = await db
        .select()
        .from(companiesTable)
        .where(eq(companiesTable.id, member.companyId))
        .limit(1);
      if (comp) code = comp.initiationCode;
    } else {
      const [settings] = await db.select().from(workspaceSettingsTable).limit(1);
      if (settings) code = settings.initiationCode;
    }
    res.json({ initiationCode: code });
  },
);

router.put(
  "/team/initiation-code",
  requireAdmin,
  async (req, res): Promise<void> => {
    const member = getRequestMember(res);
    const newCode = String(req.body?.initiationCode ?? req.body?.initiation_code ?? "").trim();
    if (!newCode) {
      res.status(400).json({ error: "Initiation code cannot be empty" });
      return;
    }

    if (member.companyId) {
      await db
        .update(companiesTable)
        .set({ initiationCode: newCode })
        .where(eq(companiesTable.id, member.companyId));
    } else {
      const [settings] = await db.select().from(workspaceSettingsTable).limit(1);
      if (settings) {
        await db
          .update(workspaceSettingsTable)
          .set({ initiationCode: newCode, updatedAt: new Date() })
          .where(eq(workspaceSettingsTable.id, settings.id));
      } else {
        await db
          .insert(workspaceSettingsTable)
          .values({ initiationCode: newCode });
      }
    }

    await addActivity("team", "Initiation code updated", newCode);
    res.json({ initiationCode: newCode });
  },
);

// POST /api/team/assign-employee - Workspace Admin assigns an Employee directly
router.post(
  "/team/assign-employee",
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = getRequestMember(res);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const name = String(req.body?.name ?? "").trim();

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
          role: "member",
          status: "active",
          companyId: admin.companyId ?? existing.companyId,
          name: name || existing.name,
        })
        .where(eq(teamMembersTable.id, existing.id))
        .returning();

      await addActivity("team", "Assigned employee to workspace", email);
      res.json({ ok: true, member: memberForResponse(updated) });
      return;
    }

    const [created] = await db
      .insert(teamMembersTable)
      .values({
        authId: randomUUID(),
        email,
        name: name || email.split("@")[0],
        role: "member",
        status: "active",
        companyId: admin.companyId,
      })
      .returning();

    await addActivity("team", "Pre-assigned employee to workspace", email);
    res.status(201).json({ ok: true, member: memberForResponse(created) });
  },
);

export default router;