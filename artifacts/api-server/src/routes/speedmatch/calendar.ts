import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { companyCalendarEventsTable, db } from "@workspace/db";
import { getRequestMember, requireActiveMember } from "../../lib/speedmatch-auth";
import { addActivity, asIso, parseRouteId } from "../../lib/speedmatch-utils";

const router: IRouter = Router();

// Lazy bootstrap table if it doesn't exist yet
let tableEnsured = false;
async function ensureCalendarTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS speedmatch_calendar_events (
        id SERIAL PRIMARY KEY,
        company_id INTEGER,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        type TEXT NOT NULL DEFAULT 'Holiday',
        is_holiday INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        uploaded_by TEXT NOT NULL DEFAULT '',
        source_file_name TEXT,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    tableEnsured = true;
  } catch (err) {
    console.warn("Could not auto-verify calendar table:", err);
  }
}

router.use("/calendar", requireActiveMember);

function isAdminMember(member: { role?: string } | null | undefined): boolean {
  if (!member) return false;
  const role = String(member.role || "").toLowerCase();
  return role === "admin" || role === "owner" || role === "super_admin";
}

interface ParsedEvent {
  title: string;
  startDate: string;
  endDate?: string;
  type: string;
  isHoliday: number;
  description: string;
  location: string;
}

/**
 * Intelligent classifier for calendar events
 */
function classifyEvent(title: string, description: string = "", categories: string = ""): { type: string; isHoliday: number } {
  const combined = `${title} ${description} ${categories}`.toLowerCase();

  const holidayKeywords = [
    "holiday", "day off", "office closed", "closure", "leave", "break",
    "new year", "martin luther", "mlk", "presidents", "memorial day",
    "juneteenth", "independence day", "4th of july", "fourth of july",
    "labor day", "columbus day", "indigenous", "veterans", "thanksgiving",
    "christmas", "xmas", "diwali", "deepavali", "eid", "ramadan",
    "good friday", "easter", "republic day", "gandhi", "boxing day",
    "bank holiday", "public holiday", "national day", "observance"
  ];

  if (holidayKeywords.some(kw => combined.includes(kw))) {
    return { type: "Holiday", isHoliday: 1 };
  }

  if (combined.includes("all hands") || combined.includes("all-hands") || combined.includes("town hall") || combined.includes("townhall")) {
    return { type: "All Hands", isHoliday: 0 };
  }

  if (combined.includes("meeting") || combined.includes("sync") || combined.includes("standup") || combined.includes("1:1")) {
    return { type: "Meeting", isHoliday: 0 };
  }

  if (combined.includes("milestone") || combined.includes("launch") || combined.includes("deadline") || combined.includes("release") || combined.includes("demo day")) {
    return { type: "Milestone", isHoliday: 0 };
  }

  if (combined.includes("offsite") || combined.includes("off-site") || combined.includes("retreat") || combined.includes("team building")) {
    return { type: "Off-site", isHoliday: 0 };
  }

  if (combined.includes("training") || combined.includes("workshop") || combined.includes("webinar") || combined.includes("onboarding")) {
    return { type: "Training", isHoliday: 0 };
  }

  return { type: "Company Event", isHoliday: 0 };
}

function normalizeDateStr(raw: string): string {
  const trimmed = raw.trim();
  // If YYYYMMDD
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
  }
  // If YYYYMMDDTHHMMSS...
  const matchIso = trimmed.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (matchIso) {
    return `${matchIso[1]}-${matchIso[2]}-${matchIso[3]}`;
  }
  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }
  // Try date parsing
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return trimmed;
}

/**
 * iCalendar (.ics) format parser
 */
function parseICS(icsContent: string): ParsedEvent[] {
  // Unfold folded lines (RFC 5545 specifies that lines starting with space or tab continue the previous line)
  const unfolded = icsContent.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events: ParsedEvent[] = [];

  let inEvent = false;
  let currentEvent: Partial<ParsedEvent> & { categories?: string } = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      inEvent = true;
      currentEvent = {};
      continue;
    }

    if (trimmed === "END:VEVENT") {
      if (inEvent && currentEvent.title && currentEvent.startDate) {
        const { type, isHoliday } = classifyEvent(
          currentEvent.title,
          currentEvent.description || "",
          currentEvent.categories || ""
        );

        events.push({
          title: currentEvent.title,
          startDate: currentEvent.startDate,
          endDate: currentEvent.endDate || currentEvent.startDate,
          type: currentEvent.type || type,
          isHoliday: currentEvent.isHoliday !== undefined ? currentEvent.isHoliday : isHoliday,
          description: currentEvent.description || "",
          location: currentEvent.location || "",
        });
      }
      inEvent = false;
      currentEvent = {};
      continue;
    }

    if (!inEvent) continue;

    // Parse VEVENT properties
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const propHeader = trimmed.slice(0, colonIdx);
    const propValue = trimmed.slice(colonIdx + 1);
    const propName = propHeader.split(";")[0].toUpperCase();

    // Clean escaped characters in iCalendar (e.g. \, \; \n)
    const cleanValue = propValue
      .replace(/\\n/gi, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\")
      .trim();

    if (propName === "SUMMARY") {
      currentEvent.title = cleanValue;
    } else if (propName === "DTSTART") {
      currentEvent.startDate = normalizeDateStr(cleanValue);
    } else if (propName === "DTEND") {
      currentEvent.endDate = normalizeDateStr(cleanValue);
    } else if (propName === "DESCRIPTION") {
      currentEvent.description = cleanValue;
    } else if (propName === "LOCATION") {
      currentEvent.location = cleanValue;
    } else if (propName === "CATEGORIES") {
      currentEvent.categories = cleanValue;
    }
  }

  return events;
}

/**
 * CSV calendar parser
 */
function parseCSV(csvContent: string): ParsedEvent[] {
  const lines = csvContent.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) return [];

  // Helper to parse CSV row respecting quotes
  function parseRow(text: string): string[] {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (inQuotes && text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = "";
      } else {
        cur += char;
      }
    }
    result.push(cur.trim());
    return result;
  }

  const headerRow = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  
  // Find column indices
  let dateIdx = headerRow.findIndex(h => h.includes("date") || h.includes("start") || h.includes("day"));
  let endIdx = headerRow.findIndex(h => h.includes("end") || h.includes("to"));
  let titleIdx = headerRow.findIndex(h => h.includes("event") || h.includes("title") || h.includes("holiday") || h.includes("name") || h.includes("summary"));
  let typeIdx = headerRow.findIndex(h => h.includes("type") || h.includes("category"));
  let descIdx = headerRow.findIndex(h => h.includes("desc") || h.includes("detail") || h.includes("note"));
  let locIdx = headerRow.findIndex(h => h.includes("loc") || h.includes("place") || h.includes("room"));

  let startRow = 1;
  // If header not found, assume standard default column layout: Date, Title, Type, Description
  if (dateIdx === -1 || titleIdx === -1) {
    dateIdx = 0;
    titleIdx = 1;
    typeIdx = 2;
    descIdx = 3;
    startRow = 0; // Check if first row is actually data
    if (/date|title|name|holiday/i.test(lines[0])) {
      startRow = 1;
    }
  }

  const events: ParsedEvent[] = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    const rawDate = cols[dateIdx] || "";
    const title = cols[titleIdx] || "";
    if (!rawDate || !title) continue;

    const startDate = normalizeDateStr(rawDate);
    const rawEndDate = endIdx !== -1 ? cols[endIdx] : "";
    const endDate = rawEndDate ? normalizeDateStr(rawEndDate) : startDate;
    const rawType = typeIdx !== -1 && cols[typeIdx] ? cols[typeIdx] : "";
    const description = descIdx !== -1 && cols[descIdx] ? cols[descIdx] : "";
    const location = locIdx !== -1 && cols[locIdx] ? cols[locIdx] : "";

    const { type: classifiedType, isHoliday: classifiedIsHoliday } = classifyEvent(title, description, rawType);

    events.push({
      title,
      startDate,
      endDate,
      type: rawType || classifiedType,
      isHoliday: rawType ? (/holiday/i.test(rawType) ? 1 : 0) : classifiedIsHoliday,
      description,
      location,
    });
  }

  return events;
}

/**
 * Standard 2026/2027 Seed Holidays and Events
 */
function getStandardHolidaysAndEvents(): ParsedEvent[] {
  return [
    { title: "New Year's Day", startDate: "2026-01-01", endDate: "2026-01-01", type: "Holiday", isHoliday: 1, description: "Official company holiday for New Year's Day.", location: "Company-wide" },
    { title: "Martin Luther King Jr. Day", startDate: "2026-01-19", endDate: "2026-01-19", type: "Holiday", isHoliday: 1, description: "Honoring Dr. Martin Luther King Jr.", location: "Company-wide" },
    { title: "Presidents' Day", startDate: "2026-02-16", endDate: "2026-02-16", type: "Holiday", isHoliday: 1, description: "Washington's Birthday public observance.", location: "Company-wide" },
    { title: "Q1 Company All-Hands & Strategy Sync", startDate: "2026-03-12", endDate: "2026-03-12", type: "All Hands", isHoliday: 0, description: "Quarterly townhall, product milestones, and team updates.", location: "Main Hall / Zoom" },
    { title: "Eid al-Fitr", startDate: "2026-03-20", endDate: "2026-03-20", type: "Holiday", isHoliday: 1, description: "Celebration marking the conclusion of Ramadan.", location: "Company-wide" },
    { title: "Memorial Day", startDate: "2026-05-25", endDate: "2026-05-25", type: "Holiday", isHoliday: 1, description: "National holiday remembering service members.", location: "Company-wide" },
    { title: "Mid-Year Hackathon & Demo Day", startDate: "2026-06-11", endDate: "2026-06-12", type: "Milestone", isHoliday: 0, description: "24-hour innovation challenge and prototype demo showcase.", location: "HQ & Virtual" },
    { title: "Juneteenth National Independence Day", startDate: "2026-06-19", endDate: "2026-06-19", type: "Holiday", isHoliday: 1, description: "Commemorating emancipation in the United States.", location: "Company-wide" },
    { title: "Independence Day", startDate: "2026-07-03", endDate: "2026-07-04", type: "Holiday", isHoliday: 1, description: "Independence Day weekend office closure.", location: "Company-wide" },
    { title: "Annual Summer Team Offsite", startDate: "2026-08-20", endDate: "2026-08-21", type: "Off-site", isHoliday: 0, description: "Team building, outdoor activities, and strategy workshops.", location: "Pine Crest Resort" },
    { title: "Labor Day", startDate: "2026-09-07", endDate: "2026-09-07", type: "Holiday", isHoliday: 1, description: "Celebrating the American labor movement and workers.", location: "Company-wide" },
    { title: "Diwali (Festival of Lights)", startDate: "2026-11-08", endDate: "2026-11-08", type: "Holiday", isHoliday: 1, description: "Festival of Lights celebration and office holiday.", location: "Company-wide" },
    { title: "Thanksgiving Day", startDate: "2026-11-26", endDate: "2026-11-27", type: "Holiday", isHoliday: 1, description: "Thanksgiving and Day After Thanksgiving company holidays.", location: "Company-wide" },
    { title: "Q4 Year-End Review & Awards", startDate: "2026-12-15", endDate: "2026-12-15", type: "All Hands", isHoliday: 0, description: "Celebrating yearly accomplishments, customer milestones, and team recognition.", location: "Auditorium & Live Stream" },
    { title: "Christmas & Winter Break", startDate: "2026-12-24", endDate: "2026-12-25", type: "Holiday", isHoliday: 1, description: "Christmas Eve and Christmas Day company holidays.", location: "Company-wide" },
  ];
}

// GET /api/calendar/events - Visible to all employees and admins
router.get("/calendar/events", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);
  const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : "";
  const typeFilter = typeof req.query.type === "string" ? req.query.type.trim() : "";
  const holidaysOnly = req.query.holidaysOnly === "true";

  try {
    const isSuper = member.role === "super_admin";
    const companyId = member.companyId;

    // Filter by company visibility:
    // If regular member/admin with companyId, show items where companyId matches OR is NULL (workspace-wide)
    let whereCondition = isSuper
      ? undefined
      : companyId
      ? or(eq(companyCalendarEventsTable.companyId, companyId), isNull(companyCalendarEventsTable.companyId))
      : isNull(companyCalendarEventsTable.companyId);

    const rows = await db
      .select()
      .from(companyCalendarEventsTable)
      .where(whereCondition)
      .orderBy(asc(companyCalendarEventsTable.startDate), asc(companyCalendarEventsTable.id));

    let filtered = rows;
    if (holidaysOnly) {
      filtered = filtered.filter(item => item.isHoliday === 1);
    }
    if (typeFilter && typeFilter !== "all") {
      filtered = filtered.filter(item => item.type.toLowerCase() === typeFilter.toLowerCase());
    }
    if (search) {
      filtered = filtered.filter(item =>
        item.title.toLowerCase().includes(search) ||
        item.description.toLowerCase().includes(search) ||
        item.location.toLowerCase().includes(search) ||
        item.type.toLowerCase().includes(search)
      );
    }

    res.json({
      events: filtered.map(item => ({
        ...item,
        createdAt: asIso(item.createdAt),
        updatedAt: asIso(item.updatedAt),
      })),
      total: filtered.length,
    });
  } catch (err: any) {
    console.error("GET /api/calendar/events error:", err);
    res.status(500).json({ error: "Failed to load company calendar events." });
  }
});

// POST /api/calendar/upload - Admin uploads .ics, .csv, or .json
router.post("/calendar/upload", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can upload and attach company calendars." });
    return;
  }

  const { fileContent, fileName = "calendar.ics", replaceExisting = false, save = true } = req.body || {};

  if (!fileContent || typeof fileContent !== "string") {
    res.status(400).json({ error: "Please provide valid calendar file content (.ics or .csv)." });
    return;
  }

  try {
    let extracted: ParsedEvent[] = [];
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith(".csv") || (!lowerName.endsWith(".ics") && fileContent.includes(","))) {
      extracted = parseCSV(fileContent);
    } else if (fileContent.includes("BEGIN:VCALENDAR") || fileContent.includes("BEGIN:VEVENT") || lowerName.endsWith(".ics")) {
      extracted = parseICS(fileContent);
    } else {
      // Try JSON
      try {
        const json = JSON.parse(fileContent);
        if (Array.isArray(json)) {
          extracted = json.map(j => ({
            title: String(j.title || j.name || "Event"),
            startDate: normalizeDateStr(String(j.startDate || j.date || new Date().toISOString().slice(0, 10))),
            endDate: j.endDate ? normalizeDateStr(String(j.endDate)) : undefined,
            type: String(j.type || "Holiday"),
            isHoliday: j.isHoliday !== undefined ? (j.isHoliday ? 1 : 0) : (/holiday/i.test(j.type) ? 1 : 0),
            description: String(j.description || ""),
            location: String(j.location || ""),
          }));
        }
      } catch {
        // Fallback to CSV
        extracted = parseCSV(fileContent);
      }
    }

    if (!extracted.length) {
      res.status(400).json({
        error: "No events or holidays could be extracted from this file. Ensure it is a valid .ics or .csv calendar."
      });
      return;
    }

    const companyId = member.role === "super_admin" ? null : member.companyId;

    if (!save) {
      // Preview only
      res.json({
        extractedCount: extracted.length,
        events: extracted,
        holidaysCount: extracted.filter(e => e.isHoliday === 1).length,
        eventsCount: extracted.filter(e => e.isHoliday === 0).length,
      });
      return;
    }

    // Replace existing if requested
    if (replaceExisting) {
      const deleteCondition = companyId
        ? eq(companyCalendarEventsTable.companyId, companyId)
        : isNull(companyCalendarEventsTable.companyId);
      await db.delete(companyCalendarEventsTable).where(deleteCondition);
    }

    // Insert extracted events
    const insertValues = extracted.map(e => ({
      companyId,
      title: e.title,
      startDate: e.startDate,
      endDate: e.endDate || e.startDate,
      type: e.type,
      isHoliday: e.isHoliday,
      description: e.description,
      location: e.location,
      uploadedBy: member.name || member.email,
      sourceFileName: fileName,
    }));

    const inserted = await db
      .insert(companyCalendarEventsTable)
      .values(insertValues)
      .returning();

    const holidaysCount = inserted.filter(e => e.isHoliday === 1).length;
    const companyEventsCount = inserted.length - holidaysCount;

    await addActivity(
      "company",
      `Company calendar attached (${inserted.length} items)`,
      `Uploaded by ${member.name}: ${holidaysCount} holidays and ${companyEventsCount} events attached from ${fileName}`
    );

    res.json({
      ok: true,
      message: `Successfully attached ${inserted.length} calendar items (${holidaysCount} holidays, ${companyEventsCount} events) to the workspace!`,
      savedCount: inserted.length,
      events: inserted.map(item => ({
        ...item,
        createdAt: asIso(item.createdAt),
        updatedAt: asIso(item.updatedAt),
      })),
    });
  } catch (err: any) {
    console.error("POST /api/calendar/upload error:", err);
    res.status(500).json({ error: "Failed to parse and save calendar file." });
  }
});

// POST /api/calendar/seed-holidays - Quick 1-click official holidays setup
router.post("/calendar/seed-holidays", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can setup the company calendar." });
    return;
  }

  try {
    const companyId = member.role === "super_admin" ? null : member.companyId;
    const defaults = getStandardHolidaysAndEvents();

    const insertValues = defaults.map(d => ({
      companyId,
      title: d.title,
      startDate: d.startDate,
      endDate: d.endDate,
      type: d.type,
      isHoliday: d.isHoliday,
      description: d.description,
      location: d.location,
      uploadedBy: member.name || member.email,
      sourceFileName: "official_2026_calendar",
    }));

    const inserted = await db
      .insert(companyCalendarEventsTable)
      .values(insertValues)
      .returning();

    await addActivity(
      "company",
      "Official company calendar initialized",
      `${inserted.length} official holidays and milestone events configured by ${member.name}`
    );

    res.json({
      ok: true,
      message: `Loaded ${inserted.length} official company holidays and events.`,
      savedCount: inserted.length,
      events: inserted.map(item => ({
        ...item,
        createdAt: asIso(item.createdAt),
        updatedAt: asIso(item.updatedAt),
      })),
    });
  } catch (err: any) {
    console.error("POST /api/calendar/seed-holidays error:", err);
    res.status(500).json({ error: "Failed to initialize company calendar." });
  }
});

// POST /api/calendar/events - Add single event manually (Admin only)
router.post("/calendar/events", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can add calendar events." });
    return;
  }

  const { title, startDate, endDate, type = "Holiday", isHoliday = 1, description = "", location = "" } = req.body || {};

  if (!title || !startDate) {
    res.status(400).json({ error: "Event title and start date are required." });
    return;
  }

  try {
    const companyId = member.role === "super_admin" ? null : member.companyId;

    const [created] = await db
      .insert(companyCalendarEventsTable)
      .values({
        companyId,
        title: title.trim(),
        startDate: normalizeDateStr(startDate),
        endDate: endDate ? normalizeDateStr(endDate) : normalizeDateStr(startDate),
        type: type.trim(),
        isHoliday: isHoliday ? 1 : 0,
        description: description.trim(),
        location: location.trim(),
        uploadedBy: member.name || member.email,
      })
      .returning();

    await addActivity(
      "company",
      `New ${created.type.toLowerCase()}: "${created.title}"`,
      `Scheduled on ${created.startDate} by ${member.name}`
    );

    res.status(201).json({
      ok: true,
      event: {
        ...created,
        createdAt: asIso(created.createdAt),
        updatedAt: asIso(created.updatedAt),
      },
    });
  } catch (err: any) {
    console.error("POST /api/calendar/events error:", err);
    res.status(500).json({ error: "Failed to create calendar event." });
  }
});

// PUT /api/calendar/events/:id - Update event (Admin only)
router.put("/calendar/events/:id", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);

  if (!id) {
    res.status(400).json({ error: "Invalid event id." });
    return;
  }

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can edit calendar events." });
    return;
  }

  const { title, startDate, endDate, type, isHoliday, description, location } = req.body || {};

  try {
    const [existing] = await db
      .select()
      .from(companyCalendarEventsTable)
      .where(eq(companyCalendarEventsTable.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Event not found." });
      return;
    }

    const [updated] = await db
      .update(companyCalendarEventsTable)
      .set({
        title: title !== undefined ? title.trim() : existing.title,
        startDate: startDate !== undefined ? normalizeDateStr(startDate) : existing.startDate,
        endDate: endDate !== undefined ? normalizeDateStr(endDate) : existing.endDate,
        type: type !== undefined ? type.trim() : existing.type,
        isHoliday: isHoliday !== undefined ? (isHoliday ? 1 : 0) : existing.isHoliday,
        description: description !== undefined ? description.trim() : existing.description,
        location: location !== undefined ? location.trim() : existing.location,
        updatedAt: new Date(),
      })
      .where(eq(companyCalendarEventsTable.id, id))
      .returning();

    res.json({
      ok: true,
      event: {
        ...updated,
        createdAt: asIso(updated.createdAt),
        updatedAt: asIso(updated.updatedAt),
      },
    });
  } catch (err: any) {
    console.error("PUT /api/calendar/events/:id error:", err);
    res.status(500).json({ error: "Failed to update calendar event." });
  }
});

// DELETE /api/calendar/events/:id - Delete single event (Admin only)
router.delete("/calendar/events/:id", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);
  const id = parseRouteId(req.params.id);

  if (!id) {
    res.status(400).json({ error: "Invalid event id." });
    return;
  }

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can delete calendar events." });
    return;
  }

  try {
    await db.delete(companyCalendarEventsTable).where(eq(companyCalendarEventsTable.id, id));
    res.status(204).end();
  } catch (err: any) {
    console.error("DELETE /api/calendar/events/:id error:", err);
    res.status(500).json({ error: "Failed to delete calendar event." });
  }
});

// DELETE /api/calendar/events - Clear all calendar items (Admin only)
router.delete("/calendar/events", async (req, res): Promise<void> => {
  await ensureCalendarTable();
  const member = getRequestMember(res);

  if (!isAdminMember(member)) {
    res.status(403).json({ error: "Only administrators can clear calendar events." });
    return;
  }

  try {
    const companyId = member.role === "super_admin" ? null : member.companyId;
    const deleteCondition = companyId
      ? eq(companyCalendarEventsTable.companyId, companyId)
      : isNull(companyCalendarEventsTable.companyId);

    await db.delete(companyCalendarEventsTable).where(deleteCondition);
    res.status(204).end();
  } catch (err: any) {
    console.error("DELETE /api/calendar/events error:", err);
    res.status(500).json({ error: "Failed to clear calendar events." });
  }
});

export default router;

