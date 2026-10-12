import { Router, type IRouter } from "express";
import { desc, eq, ilike, or } from "drizzle-orm";
import {
  companiesTable,
  contactsTable,
  db,
  dealsTable,
  tasksTable,
} from "@workspace/db";
import {
  CreateCompanyBody,
  CreateCompanyResponse,
  CreateContactBody,
  CreateContactResponse,
  CreateDealBody,
  CreateDealResponse,
  CreateTaskBody,
  CreateTaskResponse,
  DeleteCompanyParams,
  DeleteCompanyResponse,
  DeleteContactParams,
  DeleteContactResponse,
  DeleteDealParams,
  DeleteDealResponse,
  DeleteTaskParams,
  DeleteTaskResponse,
  ListCompaniesQueryParams,
  ListCompaniesResponse,
  ListContactsQueryParams,
  ListContactsResponse,
  ListDealsQueryParams,
  ListDealsResponse,
  ListTasksQueryParams,
  ListTasksResponse,
  UpdateCompanyBody,
  UpdateCompanyParams,
  UpdateCompanyResponse,
  UpdateContactBody,
  UpdateContactParams,
  UpdateContactResponse,
  UpdateDealBody,
  UpdateDealParams,
  UpdateDealResponse,
  UpdateTaskBody,
  UpdateTaskParams,
  UpdateTaskResponse,
} from "@workspace/api-zod";
import {
  addActivity,
  asCalendarDate,
  asIso,
} from "../../lib/speedmatch-utils";

const router: IRouter = Router();

function searchFilter(
  search: string | undefined,
  matches: (pattern: string) => ReturnType<typeof ilike>[],
) {
  if (!search?.trim()) return undefined;
  const pattern = `%${search.trim()}%`;
  return or(...matches(pattern));
}

const isoContact = (row: typeof contactsTable.$inferSelect) => ({
  ...row,
  createdAt: asIso(row.createdAt),
});
const isoCompany = (row: typeof companiesTable.$inferSelect) => ({
  ...row,
  createdAt: asIso(row.createdAt),
});
const isoDeal = (row: typeof dealsTable.$inferSelect) => ({
  ...row,
  createdAt: asIso(row.createdAt),
});
const isoTask = (row: typeof tasksTable.$inferSelect) => ({
  ...row,
  createdAt: asIso(row.createdAt),
});

router.get("/contacts", async (req, res): Promise<void> => {
  const query = ListContactsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(contactsTable)
    .where(
      searchFilter(query.data.search, (pattern) => [
        ilike(contactsTable.name, pattern),
        ilike(contactsTable.email, pattern),
        ilike(contactsTable.company, pattern),
        ilike(contactsTable.role, pattern),
      ]),
    )
    .orderBy(desc(contactsTable.createdAt));
  res.json(ListContactsResponse.parse(rows.map(isoContact)));
});

router.post("/contacts", async (req, res): Promise<void> => {
  const parsed = CreateContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(contactsTable)
    .values({
      ...parsed.data,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
    })
    .returning();
  await addActivity("contact", "Contact added", parsed.data.name);
  res.status(201).json(CreateContactResponse.parse(isoContact(row)));
});

router.patch("/contacts/:id", async (req, res): Promise<void> => {
  const params = UpdateContactParams.safeParse(req.params);
  const body = UpdateContactBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.error?.message ?? body.error?.message });
    return;
  }
  const [row] = await db
    .update(contactsTable)
    .set(body.data)
    .where(eq(contactsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  await addActivity("contact", "Contact updated", row.name);
  res.json(UpdateContactResponse.parse(isoContact(row)));
});

router.delete("/contacts/:id", async (req, res): Promise<void> => {
  const parsed = DeleteContactParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .delete(contactsTable)
    .where(eq(contactsTable.id, parsed.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }
  await addActivity("contact", "Contact removed", row.name);
  res.status(204).json(DeleteContactResponse.parse(undefined));
});

router.get("/companies", async (req, res): Promise<void> => {
  const query = ListCompaniesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(companiesTable)
    .where(
      searchFilter(query.data.search, (pattern) => [
        ilike(companiesTable.name, pattern),
        ilike(companiesTable.industry, pattern),
      ]),
    )
    .orderBy(desc(companiesTable.createdAt));
  res.json(ListCompaniesResponse.parse(rows.map(isoCompany)));
});

router.post("/companies", async (req, res): Promise<void> => {
  const parsed = CreateCompanyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(companiesTable).values(parsed.data).returning();
  await addActivity("company", "Company added", parsed.data.name);
  res.status(201).json(CreateCompanyResponse.parse(isoCompany(row)));
});

router.patch("/companies/:id", async (req, res): Promise<void> => {
  const params = UpdateCompanyParams.safeParse(req.params);
  const body = UpdateCompanyBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.error?.message ?? body.error?.message });
    return;
  }
  const [row] = await db
    .update(companiesTable)
    .set(body.data)
    .where(eq(companiesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  await addActivity("company", "Company updated", row.name);
  res.json(UpdateCompanyResponse.parse(isoCompany(row)));
});

router.delete("/companies/:id", async (req, res): Promise<void> => {
  const parsed = DeleteCompanyParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .delete(companiesTable)
    .where(eq(companiesTable.id, parsed.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  await addActivity("company", "Company removed", row.name);
  res.status(204).json(DeleteCompanyResponse.parse(undefined));
});

router.get("/deals", async (req, res): Promise<void> => {
  const query = ListDealsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(dealsTable)
    .where(
      searchFilter(query.data.search, (pattern) => [
        ilike(dealsTable.name, pattern),
        ilike(dealsTable.company, pattern),
        ilike(dealsTable.contact, pattern),
        ilike(dealsTable.owner, pattern),
      ]),
    )
    .orderBy(desc(dealsTable.createdAt));
  res.json(ListDealsResponse.parse(rows.map(isoDeal)));
});

router.post("/deals", async (req, res): Promise<void> => {
  const parsed = CreateDealBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(dealsTable)
    .values({
      ...parsed.data,
      expectedClose: asCalendarDate(parsed.data.expectedClose),
      closedAt: parsed.data.stage === "Won" ? new Date() : null,
    })
    .returning();
  await addActivity("deal", "Deal added", `${row.name} · $${row.value.toLocaleString()}`);
  res.status(201).json(CreateDealResponse.parse(isoDeal(row)));
});

router.patch("/deals/:id", async (req, res): Promise<void> => {
  const params = UpdateDealParams.safeParse(req.params);
  const body = UpdateDealBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.error?.message ?? body.error?.message });
    return;
  }
  const { expectedClose, ...updates } = body.data;
  const [existing] = await db
    .select()
    .from(dealsTable)
    .where(eq(dealsTable.id, params.data.id))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  const nextStage = updates.stage ?? existing.stage;
  const [row] = await db
    .update(dealsTable)
    .set({
      ...updates,
      closedAt:
        nextStage === "Won"
          ? existing.closedAt ?? new Date()
          : null,
      ...(expectedClose === undefined
        ? {}
        : { expectedClose: asCalendarDate(expectedClose) }),
    })
    .where(eq(dealsTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  await addActivity("deal", "Deal updated", row.name);
  res.json(UpdateDealResponse.parse(isoDeal(row)));
});

router.delete("/deals/:id", async (req, res): Promise<void> => {
  const parsed = DeleteDealParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .delete(dealsTable)
    .where(eq(dealsTable.id, parsed.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Deal not found" });
    return;
  }
  await addActivity("deal", "Deal removed", row.name);
  res.status(204).json(DeleteDealResponse.parse(undefined));
});

router.get("/tasks", async (req, res): Promise<void> => {
  const query = ListTasksQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(tasksTable)
    .where(
      searchFilter(query.data.search, (pattern) => [
        ilike(tasksTable.title, pattern),
        ilike(tasksTable.owner, pattern),
        ilike(tasksTable.contact, pattern),
      ]),
    )
    .orderBy(desc(tasksTable.createdAt));
  res.json(ListTasksResponse.parse(rows.map(isoTask)));
});

router.post("/tasks", async (req, res): Promise<void> => {
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(tasksTable)
    .values({
      ...parsed.data,
      dueDate: asCalendarDate(parsed.data.dueDate),
    })
    .returning();
  await addActivity("task", "Follow-up created", parsed.data.title);
  res.status(201).json(CreateTaskResponse.parse(isoTask(row)));
});

router.patch("/tasks/:id", async (req, res): Promise<void> => {
  const params = UpdateTaskParams.safeParse(req.params);
  const body = UpdateTaskBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.error?.message ?? body.error?.message });
    return;
  }
  const { dueDate, ...updates } = body.data;
  const [row] = await db
    .update(tasksTable)
    .set({
      ...updates,
      ...(dueDate === undefined ? {} : { dueDate: asCalendarDate(dueDate) }),
    })
    .where(eq(tasksTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  await addActivity("task", "Follow-up updated", row.title);
  res.json(UpdateTaskResponse.parse(isoTask(row)));
});

router.delete("/tasks/:id", async (req, res): Promise<void> => {
  const parsed = DeleteTaskParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .delete(tasksTable)
    .where(eq(tasksTable.id, parsed.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  await addActivity("task", "Follow-up removed", row.title);
  res.status(204).json(DeleteTaskResponse.parse(undefined));
});

export default router;