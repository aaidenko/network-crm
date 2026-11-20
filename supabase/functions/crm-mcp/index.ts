// Network CRM: a remote MCP server (Streamable HTTP, stateless, JSON responses)
// running as a Supabase Edge Function.
//
//   POST /crm-mcp/<MCP_SECRET>         MCP endpoint (add this URL as a Claude connector)
//   POST /crm-mcp/<MCP_SECRET>/digest  send the reminder email (pg_cron calls this monthly)

import { today, ToolError } from "./db.ts";
import { sendDigest } from "./digest.ts";
import { callTool, TOOLS } from "./tools.ts";

const SECRET = Deno.env.get("MCP_SECRET") ?? "";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `This is the user's personal professional network: people they know, how they met,
conversations they've had, and follow-ups they owe.
- The user will often speak loosely ("grabbed coffee with Marcus yesterday, he's raising a fund").
  Turn that into tool calls: find the person first, add them if new, then log_interaction with a
  useful summary. Resolve relative dates ("yesterday", "last Tuesday") to YYYY-MM-DD.
- Never create duplicates: use find_people before add_person. If a name is ambiguous, ask.
- Capture durable facts (new job, kids' names, interests) with update_person, not just in the
  interaction summary.
- When asked who to reach out to, use who_to_reach_out and suggest a concrete reason to reconnect
  drawn from past interactions.`;

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handle(msg: RpcMessage): Promise<unknown | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion as string;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "network-crm", title: "Network CRM", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(annotations ? { annotations } : {}),
        })),
      });
    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await callTool(name, args);
        return reply({ content: [{ type: "text", text: JSON.stringify({ today: today(), result }, null, 1) }] });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `Error: ${(e as Error).message}`;
        if (!(e instanceof ToolError)) console.error(name, e);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

Deno.serve(async (req) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const rest = parts[0] === "crm-mcp" ? parts.slice(1) : parts;

  if (!SECRET || !rest[0] || !safeEqual(rest[0], SECRET)) return new Response("Not found", { status: 404 });

  if (rest[1] === "digest" && req.method === "POST") {
    try {
      return json(await sendDigest());
    } catch (e) {
      console.error("digest", e);
      return json({ sent: false, error: (e as Error).message }, 500);
    }
  }
  if (rest.length > 1) return new Response("Not found", { status: 404 });

  // Stateless server: no SSE stream, no sessions.
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  let body: RpcMessage | RpcMessage[];
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handle))).filter((r) => r !== null);
    return replies.length ? json(replies) : new Response(null, { status: 202 });
  }
  const r = await handle(body);
  return r === null ? new Response(null, { status: 202 }) : json(r);
});
