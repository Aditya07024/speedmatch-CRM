import { db, activitiesTable } from "@workspace/db";

export async function addActivity(
  kind: string,
  title: string,
  detail = "",
): Promise<void> {
  await db.insert(activitiesTable).values({ kind, title, detail });
}

export function parseRouteId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function asCalendarDate(
  value: Date | string | null | undefined,
): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}