import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

export const TIMEZONE = Deno.env.get("CRM_TIMEZONE") ?? "America/Los_Angeles";

/** Today's date (YYYY-MM-DD) in the owner's timezone. */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** An error whose message is shown to Claude as a tool result. */
export class ToolError extends Error {}

export function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export type PersonRow = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null;
  how_met: string | null;
  met_on: string | null;
  introduced_by: string | null;
  tags: string[];
  cadence_days: number;
  notes: string | null;
  archived: boolean;
  last_contact: string | null;
  next_due: string;
  open_follow_ups: number;
};

/** A compact view of a person for lists. Drops empty fields. */
export function brief(p: PersonRow) {
  const t = today();
  return compact({
    id: p.id,
    name: p.name,
    company: p.company,
    role: p.role,
    tags: p.tags.length ? p.tags : null,
    last_contact: p.last_contact ?? "never logged",
    next_due: p.next_due,
    days_overdue: Math.max(0, daysBetween(p.next_due, t)) || null,
    open_follow_ups: p.open_follow_ups || null,
    archived: p.archived || null,
  });
}

export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  ) as Partial<T>;
}

/** People past their cadence plus follow-ups due, most overdue first. */
export async function reachOutList(opts: { limit?: number; tag?: string } = {}) {
  const t = today();
  let q = db.from("people_status").select("*").eq("archived", false).lte("next_due", t);
  if (opts.tag) q = q.contains("tags", [opts.tag.toLowerCase()]);
  const people = check(await q.order("next_due").limit(opts.limit ?? 10)) as PersonRow[];

  const followUps = check(
    await db
      .from("follow_ups")
      .select("id, description, due_on, people!inner(name, archived)")
      .is("done_at", null)
      .eq("people.archived", false)
      .lte("due_on", t)
      .order("due_on"),
  ) as unknown as Array<{ id: string; description: string; due_on: string; people: { name: string } }>;

  return {
    overdue: people.map(brief),
    follow_ups_due: followUps.map((f) => ({
      id: f.id,
      person: f.people.name,
      description: f.description,
      due_on: f.due_on,
    })),
  };
}
