import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, notesTable, teamMembersTable } from "@workspace/db";
import { getRequestMember, requireActiveMember } from "../../lib/speedmatch-auth";
import { addActivity, asIso, parseRouteId } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

// Lazy bootstrap table if it doesn't exist yet
let tableEnsured = false;
async function ensureNotesTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS speedmatch_notes (
        id SERIAL PRIMARY KEY,
        company_id INTEGER,
        author_id INTEGER NOT NULL REFERENCES speedmatch_team_members(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL DEFAULT '',
        author_email TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'General',
        color TEXT NOT NULL DEFAULT 'default',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_shared INTEGER NOT NULL DEFAULT 0,
        shared_with TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    tableEnsured = true;
  } catch (err) {
    console.warn("Could not auto-verify notes table (might already exist):", err);
  }
}

router.use("/notes", requireActiveMember);

function formatNote(note: typeof notesTable.$inferSelect, currentMemberId: number) {
  return {
    ...note,
    isOwner: note.authorId === currentMemberId,
    createdAt: asIso(note.createdAt),
    updatedAt: asIso(note.updatedAt),
  };
}

// GET /api/notes - List notes visible to the current member
router.get("/notes", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const filter = typeof req.query.filter === "string" ? req.query.filter : "all"; // 'all' | 'mine' | 'shared' | 'pinned'
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";

  try {
    // Visibility condition:
    // Super Admin sees all notes in the workspace/system.
    // Regular members see:
    // 1) Their own notes (authorId == member.id)
    // 2) Notes explicitly shared with the team (isShared == 1) within the same company/workspace
    let visibilityCondition = member.role === "super_admin"
      ? sql`true`
      : or(
          eq(notesTable.authorId, member.id),
          and(
            eq(notesTable.isShared, 1),
            member.companyId
              ? or(eq(notesTable.companyId, member.companyId), sql`${notesTable.companyId} IS NULL`)
              : sql`true`
          )
        );

    const conditions = [visibilityCondition];

    // Filter type
    if (filter === "mine") {
      conditions.push(eq(notesTable.authorId, member.id));
    } else if (filter === "shared") {
      conditions.push(eq(notesTable.isShared, 1));
    } else if (filter === "pinned") {
      conditions.push(eq(notesTable.isPinned, 1));
    }

    // Category filter
    if (category && category.toLowerCase() !== "all") {
      conditions.push(ilike(notesTable.category, category));
    }

    // Search query filter (matches title, content, or category)
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        or(
          ilike(notesTable.title, pattern),
          ilike(notesTable.content, pattern),
          ilike(notesTable.category, pattern),
          ilike(notesTable.authorName, pattern)
        )!
      );
    }

    const rows = await db
      .select()
      .from(notesTable)
      .where(and(...conditions))
      .orderBy(desc(notesTable.isPinned), desc(notesTable.updatedAt));

    res.json(rows.map((row) => formatNote(row, member.id)));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to load notes" });
  }
});

// POST /api/notes - Create a new note
router.post("/notes", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const {
    title,
    content = "",
    category = "General",
    color = "default",
    isPinned = 0,
    isShared = 0,
    sharedWith = "all",
  } = req.body || {};

  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "Title is required for a note" });
    return;
  }

  try {
    const [created] = await db
      .insert(notesTable)
      .values({
        companyId: member.companyId ?? null,
        authorId: member.id,
        authorName: member.name || "Teammate",
        authorEmail: member.email || "",
        title: title.trim(),
        content: typeof content === "string" ? content.trim() : "",
        category: typeof category === "string" && category.trim() ? category.trim() : "General",
        color: typeof color === "string" ? color : "default",
        isPinned: isPinned ? 1 : 0,
        isShared: isShared ? 1 : 0,
        sharedWith: typeof sharedWith === "string" ? sharedWith : "all",
      })
      .returning();

    await addActivity(
      "note",
      created.isShared ? "Shared team note created" : "Personal note saved",
      created.title
    ).catch(() => {});

    res.status(201).json(formatNote(created, member.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to create note" });
  }
});

// PUT /api/notes/:id - Update an existing note
router.put("/notes/:id", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid note id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    const canEdit =
      existing.authorId === member.id ||
      member.role === "admin" ||
      member.role === "super_admin";

    if (!canEdit) {
      res.status(403).json({ error: "You do not have permission to edit this note" });
      return;
    }

    const {
      title,
      content,
      category,
      color,
      isPinned,
      isShared,
      sharedWith,
    } = req.body || {};

    const updates: Partial<typeof notesTable.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (title !== undefined) updates.title = String(title).trim();
    if (content !== undefined) updates.content = String(content);
    if (category !== undefined) updates.category = String(category).trim() || "General";
    if (color !== undefined) updates.color = String(color);
    if (isPinned !== undefined) updates.isPinned = isPinned ? 1 : 0;
    if (isShared !== undefined) updates.isShared = isShared ? 1 : 0;
    if (sharedWith !== undefined) updates.sharedWith = String(sharedWith);

    const [updated] = await db
      .update(notesTable)
      .set(updates)
      .where(eq(notesTable.id, id))
      .returning();

    res.json(formatNote(updated, member.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to update note" });
  }
});

// DELETE /api/notes/:id - Delete a note
router.delete("/notes/:id", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid note id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    const canDelete =
      existing.authorId === member.id ||
      member.role === "admin" ||
      member.role === "super_admin";

    if (!canDelete) {
      res.status(403).json({ error: "You do not have permission to delete this note" });
      return;
    }

    await db.delete(notesTable).where(eq(notesTable.id, id));
    res.json({ success: true, id });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to delete note" });
  }
});

// POST /api/notes/:id/toggle-share - Quickly toggle team sharing
router.post("/notes/:id/toggle-share", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid note id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    const canModify =
      existing.authorId === member.id ||
      member.role === "admin" ||
      member.role === "super_admin";

    if (!canModify) {
      res.status(403).json({ error: "You cannot change sharing settings for this note" });
      return;
    }

    const newSharedStatus = existing.isShared ? 0 : 1;
    const [updated] = await db
      .update(notesTable)
      .set({
        isShared: newSharedStatus,
        updatedAt: new Date(),
      })
      .where(eq(notesTable.id, id))
      .returning();

    await addActivity(
      "note",
      newSharedStatus ? "Shared note with team" : "Made note private",
      updated.title
    ).catch(() => {});

    res.json(formatNote(updated, member.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to toggle share status" });
  }
});

// POST /api/notes/:id/toggle-pin - Quickly toggle pin status
router.post("/notes/:id/toggle-pin", async (req, res): Promise<void> => {
  await ensureNotesTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);
  if (!id) {
    res.status(400).json({ error: "Invalid note id" });
    return;
  }

  try {
    const [existing] = await db
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Note not found" });
      return;
    }

    const newPinnedStatus = existing.isPinned ? 0 : 1;
    const [updated] = await db
      .update(notesTable)
      .set({
        isPinned: newPinnedStatus,
        updatedAt: new Date(),
      })
      .where(eq(notesTable.id, id))
      .returning();

    res.json(formatNote(updated, member.id));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to toggle pin status" });
  }
});

export default router;
