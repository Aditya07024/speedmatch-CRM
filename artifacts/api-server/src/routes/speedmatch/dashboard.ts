import { Router, type IRouter } from "express";
import { desc, eq, ne } from "drizzle-orm";
import {
  activitiesTable,
  contactsTable,
  db,
  dealsTable,
  tasksTable,
  teamMembersTable,
} from "@workspace/db";
import {
  GetAnalyticsResponse,
  GetDashboardActivityResponse,
  GetDashboardSummaryResponse,
} from "@workspace/api-zod";
import { asIso } from "../../lib/speedmatch-utils";

const router: IRouter = Router();
const stages = ["Lead", "Qualified", "Proposal", "Negotiation"];

function monthKey(date: Date): string {
  return date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

function lastSixMonths(): Array<{ key: string; month: string }> {
  const current = new Date();
  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 5 + index, 1),
    );
    return {
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      month: monthKey(date),
    };
  });
}

function revenueByMonth(
  deals: Array<{
    value: number;
    stage: string;
    closedAt: Date | null;
  }>,
) {
  const months = lastSixMonths();
  return months.map(({ key, month }) => ({
    month,
    amount: deals
      .filter(
        (deal) =>
          deal.stage === "Won" &&
          !!deal.closedAt &&
          `${deal.closedAt.getUTCFullYear()}-${String(deal.closedAt.getUTCMonth() + 1).padStart(2, "0")}` ===
            key,
      )
      .reduce((sum, deal) => sum + deal.value, 0),
  }));
}

function dealStages(
  deals: Array<{ value: number; stage: string }>,
) {
  return stages.map((stage) => {
    const matching = deals.filter((deal) => deal.stage === stage);
    return {
      stage,
      count: matching.length,
      value: matching.reduce((sum, deal) => sum + deal.value, 0),
    };
  });
}

router.get("/dashboard", async (_req, res): Promise<void> => {
  const [contacts, deals, tasks, pending] = await Promise.all([
    db.select().from(contactsTable),
    db.select().from(dealsTable),
    db.select().from(tasksTable),
    db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.status, "pending")),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const activeDeals = deals.filter(
    (deal) => deal.stage !== "Won" && deal.stage !== "Lost",
  );
  const currentMonth = new Date().toISOString().slice(0, 7);
  const wonThisMonth = deals
    .filter(
      (deal) =>
        deal.stage === "Won" &&
        !!deal.closedAt &&
        deal.closedAt.toISOString().slice(0, 7) === currentMonth,
    )
    .reduce((sum, deal) => sum + deal.value, 0);

  res.json(
    GetDashboardSummaryResponse.parse({
      contacts: contacts.length,
      openDeals: activeDeals.length,
      pipelineValue: activeDeals.reduce((sum, deal) => sum + deal.value, 0),
      wonThisMonth,
      tasksDue: tasks.filter(
        (task) =>
          !/complete/i.test(task.status || "") &&
          !!task.dueDate &&
          task.dueDate <= today,
      ).length,
      pendingJoinees: pending.length,
      monthlyRevenue: revenueByMonth(deals),
      stageBreakdown: dealStages(deals),
    }),
  );
});

router.get("/dashboard/activity", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(activitiesTable)
    .where(ne(activitiesTable.kind, "superadmin"))
    .orderBy(desc(activitiesTable.createdAt))
    .limit(20);
  res.json(
    GetDashboardActivityResponse.parse(
      rows.map((row) => ({ ...row, createdAt: asIso(row.createdAt) })),
    ),
  );
});

router.get("/analytics", async (_req, res): Promise<void> => {
  const deals = await db.select().from(dealsTable);
  const won = deals.filter((deal) => deal.stage === "Won");
  const closed = deals.filter(
    (deal) => deal.stage === "Won" || deal.stage === "Lost",
  );
  const activeDeals = deals.filter(
    (deal) => deal.stage !== "Won" && deal.stage !== "Lost",
  );
  const owners = [...new Set(activeDeals.map((deal) => deal.owner))];

  res.json(
    GetAnalyticsResponse.parse({
      pipelineValue: deals
        .filter((deal) => deal.stage !== "Won" && deal.stage !== "Lost")
        .reduce((sum, deal) => sum + deal.value, 0),
      wonValue: won.reduce((sum, deal) => sum + deal.value, 0),
      conversionRate: closed.length ? (won.length / closed.length) * 100 : 0,
      averageDealSize: deals.length
        ? deals.reduce((sum, deal) => sum + deal.value, 0) / deals.length
        : 0,
      monthlyRevenue: revenueByMonth(deals),
      stageBreakdown: dealStages(deals),
      ownerBreakdown: owners.map((owner) => {
        const matching = activeDeals.filter((deal) => deal.owner === owner);
        return {
          owner,
          count: matching.length,
          value: matching.reduce((sum, deal) => sum + deal.value, 0),
        };
      }),
    }),
  );
});

export default router;