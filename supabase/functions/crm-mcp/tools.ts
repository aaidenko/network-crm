import { brief, check, compact, db, type PersonRow, reachOutList, today, ToolError } from "./db.ts";

type Args = Record<string, unknown>;
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: Args) => Promise<unknown>;
};

const str = (description: string) => ({ type: "string", description });
const date = (description: string) => ({ type: "string", format: "date", description: `${description} (YYYY-MM-DD)` });

const personFields = {
  name: str("Full name"),
  company: str("Current company or organization"),
  role: str("Title or role"),
  email: str("Email address"),
  phone: str("Phone number"),
  linkedin: str("LinkedIn URL or handle"),
  location: str("City / where they're based"),
  how_met: str("How and where you met, e.g. 'Stanford alumni mixer, intro'd by Sam'"),
  met_on: date("When you met"),
  introduced_by: str("Who introduced you, if anyone"),
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Short lowercase labels, e.g. stanford, investor, mentor, recruiting",
  },
  cadence_days: {
    type: "integer",
    minimum: 1,
    description: "How often to stay in touch, in days. Roughly 30 = close, 90 = warm (default), 180 = loose.",
  },
  notes: str("Freeform background: interests, family, what they care about"),
};
const PERSON_KEYS = Object.keys(personFields) as (keyof typeof personFields)[];

const personRef = str("The person's name (fuzzy match is fine) or their id");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Find exactly one person by id or name, or explain why not. */
async function resolvePerson(ref: unknown, includeArchived = false): Promise<PersonRow> {
  if (typeof ref !== "string" || !ref.trim()) throw new ToolError("A person name or id is required.");
  ref = ref.trim();
  const r = ref as string;

  if (UUID.test(r)) {
    const row = check(await db.from("people_status").select("*").eq("id", r).maybeSingle());
    if (!row) throw new ToolError(`No person with id ${r}.`);
    return row as PersonRow;
  }

  const escaped = r.replace(/[\\%_]/g, (c) => `\\${c}`);
  let exactQ = db.from("people_status").select("*").ilike("name", escaped);
  if (!includeArchived) exactQ = exactQ.eq("archived", false);
  const exact = check(await exactQ) as PersonRow[];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw ambiguous(r, exact);

  const fuzzy = check(await db.rpc("search_people", { q: r, lim: 5 })) as PersonRow[];
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length === 0) {
    throw new ToolError(`No one matching "${r}". Use find_people to search, or add_person to create them.`);
  }
  throw ambiguous(r, fuzzy);
}

function ambiguous(ref: string, rows: PersonRow[]) {
  const list = rows.map((p) => `- ${p.name}${p.company ? ` (${p.company})` : ""} [id ${p.id}]`).join("\n");
  return new ToolError(`"${ref}" matches several people. Ask which one, then retry with the id:\n${list}`);
}

function pickPersonFields(args: Args) {
  const out: Record<string, unknown> = {};
  for (const k of PERSON_KEYS) if (args[k] !== undefined) out[k] = args[k];
  if (Array.isArray(out.tags)) out.tags = normTags(out.tags as string[]);
  return out;
}

const normTags = (tags: string[]) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

export const TOOLS: Tool[] = [
  {
    name: "who_to_reach_out",
    description:
      "List people you're overdue to contact (past their cadence) and follow-ups that are due. " +
      "Use when asked who to reach out to, who they've lost touch with, or what they owe people.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max people (default 10)" },
        tag: str("Only people with this tag"),
      },
    },
    annotations: { readOnlyHint: true },
    run: (a) => reachOutList({ limit: a.limit as number, tag: a.tag as string }),
  },
  {
    name: "find_people",
    description:
      "Search your network. Fuzzy-matches name, company, role, how you met, and tags. " +
      "With no arguments, lists everyone. Always search before adding someone new.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Free text: a name, company, event, etc."),
        tag: str("Only people with this tag"),
        include_archived: { type: "boolean", description: "Include archived people (default false)" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results (default 25)" },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const limit = (a.limit as number) ?? 25;
      const tag = (a.tag as string | undefined)?.toLowerCase();
      let rows: PersonRow[];
      if (a.query) {
        rows = check(await db.rpc("search_people", { q: a.query, lim: 200 })) as PersonRow[];
        if (tag) rows = rows.filter((p) => p.tags.includes(tag));
      } else {
        let q = db.from("people_status").select("*").order("name");
        if (!a.include_archived) q = q.eq("archived", false);
        if (tag) q = q.contains("tags", [tag]);
        rows = check(await q.limit(limit)) as PersonRow[];
      }
      return { count: rows.length, people: rows.slice(0, limit).map(brief) };
    },
  },
  {
    name: "get_person",
    description: "Full profile for one person: contact info, how you met, notes, interaction history, open follow-ups.",
    inputSchema: { type: "object", properties: { person: personRef }, required: ["person"] },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const p = await resolvePerson(a.person);
      const [interactions, followUps] = await Promise.all([
        db.from("interactions").select("id, occurred_on, channel, summary")
          .eq("person_id", p.id).order("occurred_on", { ascending: false }).limit(50),
        db.from("follow_ups").select("id, description, due_on")
          .eq("person_id", p.id).is("done_at", null).order("due_on"),
      ]);
      return {
        ...brief(p),
        ...compact({
          email: p.email,
          phone: p.phone,
          linkedin: p.linkedin,
          location: p.location,
          how_met: p.how_met,
          met_on: p.met_on,
          introduced_by: p.introduced_by,
          cadence_days: p.cadence_days,
          notes: p.notes,
        }),
        interactions: check(interactions),
        open_follow_ups: check(followUps),
      };
    },
  },
  {
    name: "add_person",
    description:
      "Add someone to your network. If a person with the same name exists, returns them instead " +
      "unless allow_duplicate is true. To record a conversation, call log_interaction afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        ...personFields,
        allow_duplicate: { type: "boolean", description: "Create even if the name already exists" },
      },
      required: ["name"],
    },
    run: async (a) => {
      const fields = pickPersonFields(a);
      if (!a.allow_duplicate) {
        const escaped = String(a.name).trim().replace(/[\\%_]/g, (c) => `\\${c}`);
        const existing = check(await db.from("people_status").select("*").ilike("name", escaped)) as PersonRow[];
        if (existing.length) {
          return {
            status: "already_exists",
            message: "Someone with this name exists. Update them with update_person, or retry with allow_duplicate.",
            existing: existing.map(brief),
          };
        }
      }
      const row = check(await db.from("people").insert(fields).select("id").single()) as { id: string };
      return { status: "added", person: brief(await resolvePerson(row.id)) };
    },
  },
  {
    name: "update_person",
    description:
      "Change details about someone: any profile field, cadence, tags, or notes. " +
      "Use add_tags/remove_tags to edit tags without replacing them, and append_note to add to notes.",
    inputSchema: {
      type: "object",
      properties: {
        person: personRef,
        ...personFields,
        add_tags: { type: "array", items: { type: "string" } },
        remove_tags: { type: "array", items: { type: "string" } },
        append_note: str("Text to add to the end of their notes, stamped with today's date"),
      },
      required: ["person"],
    },
    run: async (a) => {
      const p = await resolvePerson(a.person);
      const patch = pickPersonFields(a);
      if (a.add_tags || a.remove_tags) {
        const remove = new Set(normTags((a.remove_tags as string[]) ?? []));
        const base = (patch.tags as string[] | undefined) ?? p.tags;
        patch.tags = normTags([...base, ...((a.add_tags as string[]) ?? [])]).filter((t) => !remove.has(t));
      }
      if (a.append_note) {
        const line = `[${today()}] ${a.append_note}`;
        const base = (patch.notes as string | undefined) ?? p.notes;
        patch.notes = base ? `${base}\n${line}` : line;
      }
      if (!Object.keys(patch).length) throw new ToolError("Nothing to update.");
      check(await db.from("people").update(patch).eq("id", p.id));
      return { status: "updated", changed: Object.keys(patch), person: brief(await resolvePerson(p.id)) };
    },
  },
  {
    name: "log_interaction",
    description:
      "Record that you talked to someone: when, how, and what about. Resets their reach-out clock. " +
      "Optionally adds a follow-up (something you promised or want to do next).",
    inputSchema: {
      type: "object",
      properties: {
        person: personRef,
        summary: str("What you talked about, key details worth remembering"),
        channel: str("coffee, call, text, email, video, event, linkedin, etc."),
        date: date("When it happened; defaults to today"),
        follow_up: str("Something to do next, e.g. 'send intro to Dana'"),
        follow_up_due: date("When the follow-up is due"),
      },
      required: ["person", "summary"],
    },
    run: async (a) => {
      const p = await resolvePerson(a.person);
      const interaction = check(
        await db.from("interactions").insert({
          person_id: p.id,
          summary: a.summary,
          channel: a.channel ?? null,
          occurred_on: a.date ?? today(),
        }).select("id, occurred_on").single(),
      );
      let followUp = null;
      if (a.follow_up) {
        followUp = check(
          await db.from("follow_ups").insert({
            person_id: p.id,
            description: a.follow_up,
            due_on: a.follow_up_due ?? null,
          }).select("id, description, due_on").single(),
        );
      }
      return { status: "logged", interaction, follow_up: followUp, person: brief(await resolvePerson(p.id)) };
    },
  },
  {
    name: "list_follow_ups",
    description: "List open follow-ups (things you owe people), optionally for one person.",
    inputSchema: {
      type: "object",
      properties: {
        person: personRef,
        include_done: { type: "boolean", description: "Also show completed ones" },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      let q = db.from("follow_ups").select("id, description, due_on, done_at, people!inner(id, name)")
        .order("due_on", { nullsFirst: false });
      if (a.person) q = q.eq("person_id", (await resolvePerson(a.person)).id);
      if (!a.include_done) q = q.is("done_at", null);
      const rows = check(await q) as unknown as Array<
        { id: string; description: string; due_on: string | null; done_at: string | null; people: { name: string } }
      >;
      return rows.map((f) => compact({ id: f.id, person: f.people.name, description: f.description, due_on: f.due_on, done_at: f.done_at }));
    },
  },
  {
    name: "complete_follow_up",
    description: "Mark a follow-up as done. Get its id from list_follow_ups or get_person.",
    inputSchema: { type: "object", properties: { id: str("Follow-up id") }, required: ["id"] },
    run: async (a) => {
      const rows = check(
        await db.from("follow_ups").update({ done_at: new Date().toISOString() }).eq("id", a.id).select("id, description"),
      ) as unknown[];
      if (!rows.length) throw new ToolError(`No follow-up with id ${a.id}.`);
      return { status: "done", follow_up: rows[0] };
    },
  },
  {
    name: "delete_interaction",
    description: "Delete a logged interaction (e.g. one logged by mistake). Get its id from get_person.",
    inputSchema: { type: "object", properties: { id: str("Interaction id") }, required: ["id"] },
    annotations: { destructiveHint: true },
    run: async (a) => {
      const rows = check(await db.from("interactions").delete().eq("id", a.id).select("id")) as unknown[];
      if (!rows.length) throw new ToolError(`No interaction with id ${a.id}.`);
      return { status: "deleted" };
    },
  },
  {
    name: "archive_person",
    description:
      "Archive someone so they stop showing up in reminders and searches (history is kept). " +
      "Pass archived=false to restore.",
    inputSchema: {
      type: "object",
      properties: { person: personRef, archived: { type: "boolean", description: "Default true" } },
      required: ["person"],
    },
    run: async (a) => {
      const archived = a.archived ?? true;
      const p = await resolvePerson(a.person, !archived);
      check(await db.from("people").update({ archived }).eq("id", p.id));
      return { status: archived ? "archived" : "restored", person: p.name };
    },
  },
];

export async function callTool(name: string, args: Args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  return await tool.run(args ?? {});
}
