import { reachOutList } from "./db.ts";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Email a short "who to reach out to" list. Called weekly by pg_cron. */
export async function sendDigest(): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("DIGEST_EMAIL");
  if (!apiKey || !to) return { sent: false, reason: "RESEND_API_KEY or DIGEST_EMAIL not set" };

  const { overdue, follow_ups_due } = await reachOutList({ limit: 8 });
  if (!overdue.length && !follow_ups_due.length) return { sent: false, reason: "nothing due" };

  const people = overdue.map((p) => {
    const last = p.last_contact === "never logged" ? "no conversations logged yet" : `last talked ${p.last_contact}`;
    const who = [p.name, p.role, p.company].filter(Boolean).map((s) => esc(String(s))).join(", ");
    return `<li><b>${who}</b> &middot; ${esc(last)}</li>`;
  }).join("");
  const followUps = follow_ups_due
    .map((f) => `<li><b>${esc(f.person)}</b>: ${esc(f.description)} (due ${f.due_on})</li>`)
    .join("");

  const html = [
    `<p>A few people worth reaching out to this week:</p>`,
    people && `<ul>${people}</ul>`,
    followUps && `<p>Follow-ups due:</p><ul>${followUps}</ul>`,
    `<p style="color:#888">Log a catch-up by telling Claude, e.g. "had coffee with Priya today, talked about…"</p>`,
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("DIGEST_FROM") ?? "Network CRM <onboarding@resend.dev>",
      to: [to],
      subject: `Reach out: ${overdue.length} people, ${follow_ups_due.length} follow-ups`,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return { sent: true, people: overdue.length, follow_ups: follow_ups_due.length };
}
