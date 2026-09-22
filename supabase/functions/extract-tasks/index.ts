// Supabase Edge Function: extract action items from a daily call summary
// with Claude and return them as task proposals. Nothing is written to the
// database here — the app shows the proposals for review first.
//
// Deploy: Supabase dashboard > Edge Functions > Deploy a new function >
// Via Editor, name it "extract-tasks", paste this file, Deploy.
// Secret: Edge Functions > Secrets > ANTHROPIC_API_KEY = your key.
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.
//
// The caller's own login is used for every database read, so row-level
// security applies: only approved team members get an answer.

import Anthropic from "npm:@anthropic-ai/sdk@0.127.0";
import { zodOutputFormat } from "npm:@anthropic-ai/sdk@0.127.0/helpers/zod";
import { z } from "npm:zod@4.6.5";
import { createClient } from "npm:@supabase/supabase-js@2";

export const MODEL = "claude-opus-5";
const MAX_NOTE_CHARS = 200_000; // about 50k tokens; longer notes are refused, never cut

const TaskSchema = z.object({
  person: z.string().nullable(),
  body: z.string(),
  due_date: z.string().nullable(),
  shot_name: z.string().nullable(),
  milestone_title: z.string().nullable(),
  source_quote: z.string(),
});
const ResultSchema = z.object({ tasks: z.array(TaskSchema) });

const SYSTEM = `You turn the notes of a film production's daily call into a task list.

Always write in English. If the notes are in another language, translate the task text and any new milestone title into English.

Extract every concrete action item: something a specific person or the team agreed to do, check, deliver, book or decide. Skip plain status reports, observations and anything already done.

For each task:
- person: exactly one name from the team list, copied verbatim. Match nicknames or first names to the list. If nobody from the list is clearly responsible, use null.
- body: a short imperative sentence in English (e.g. "Book the fog machine for Thursday").
- due_date: YYYY-MM-DD when the notes give or clearly imply a date (resolve "tomorrow", "Friday", "next week" relative to the call date); otherwise null.
- shot_name: exactly one name from the shot list when the task is about a specific shot; otherwise null.
- milestone_title: when the task feeds a milestone or deadline (e.g. "VFX turnover", "picture lock", "shoot day 3"), its title. Reuse the exact title from the milestone list when it refers to an existing one; otherwise a short new title in English. null when no milestone is mentioned.
- source_quote: the sentence from the notes the task comes from, copied verbatim in its original language so people can find it, at most 200 characters.

Return an empty list when there are no action items. Do not invent tasks.`;

export function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<img[^>]*>/gi, " [image] ")
    .replace(/<(br|\/p|\/li|\/h[1-6]|\/tr|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

export function buildPrompt(daily: { day: string; title: string }, notes: string, team: string[], shots: string[], milestones: { title: string; date: string; kind: string }[]): string {
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join("\n") : "(none)");
  return [
    `Call date: ${daily.day}${daily.title ? ` — ${daily.title}` : ""}`,
    `Team:\n${list(team)}`,
    `Shots:\n${list(shots)}`,
    `Existing milestones and deadlines:\n${list(milestones.map((m) => `${m.title} (${m.kind}, ${m.date})`))}`,
    `<notes>\n${notes}\n</notes>`,
  ].join("\n\n");
}

/** Keep only values that exist in the project; never trust the model blindly. */
export function sanitize(tasks: z.infer<typeof TaskSchema>[], team: string[], shots: string[], milestones: { title: string }[]) {
  const byLower = (list: string[]) => new Map(list.map((x) => [x.toLowerCase(), x]));
  const teamMap = byLower(team);
  const shotMap = byLower(shots);
  const msMap = byLower(milestones.map((m) => m.title));
  return tasks
    .map((t) => {
      const body = String(t.body || "").trim().slice(0, 2000);
      const due = t.due_date && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date) && !Number.isNaN(Date.parse(t.due_date)) ? t.due_date : null;
      const ms = t.milestone_title ? String(t.milestone_title).trim().slice(0, 200) : "";
      return {
        person: (t.person && teamMap.get(t.person.trim().toLowerCase())) || null,
        body,
        due_date: due,
        shot_name: (t.shot_name && shotMap.get(t.shot_name.trim().toLowerCase())) || null,
        milestone_title: ms ? (msMap.get(ms.toLowerCase()) || ms) : null,
        source_quote: String(t.source_quote || "").slice(0, 300),
      };
    })
    .filter((t) => t.body);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Deps = {
  env: (name: string) => string | undefined;
  supabase: (url: string, key: string, auth: string) => any;
  anthropic: (apiKey: string) => any;
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Not signed in" }, 401);
  const apiKey = deps.env("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The ANTHROPIC_API_KEY secret is not set for this Edge Function." }, 500);

  let dailyId = "";
  try { dailyId = String((await req.json()).daily_id || ""); } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/i.test(dailyId)) return json({ error: "daily_id is missing" }, 400);

  const sb = deps.supabase(deps.env("SUPABASE_URL")!, deps.env("SUPABASE_ANON_KEY")!, auth);
  const { data: approved, error: approvalError } = await sb.rpc("is_approved");
  if (approvalError || approved !== true) return json({ error: "Your account is not approved for this project." }, 403);

  const [daily, team, shots, milestones] = await Promise.all([
    sb.from("dailies").select("id, day, title, content").eq("id", dailyId).maybeSingle(),
    sb.from("team_members").select("name").order("sort_order"),
    sb.from("shots").select("shot_name").order("sort_order"),
    sb.from("milestones").select("title, date, kind").order("date"),
  ]);
  if (daily.error || !daily.data) return json({ error: "Daily summary not found." }, 404);
  const teamNames: string[] = (team.data || []).map((r: { name: string }) => r.name);
  const shotNames: string[] = (shots.data || []).map((r: { shot_name: string }) => r.shot_name).filter(Boolean);
  const msList: { title: string; date: string; kind: string }[] = milestones.error ? [] : milestones.data || [];

  const notes = htmlToText(daily.data.content);
  if (!notes) return json({ tasks: [], model: MODEL });
  if (notes.length > MAX_NOTE_CHARS) {
    return json({ error: `This summary is too long for one extraction (${notes.length} characters, limit ${MAX_NOTE_CHARS}). Split it into several days.` }, 413);
  }

  const client = deps.anthropic(apiKey);
  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium", format: zodOutputFormat(ResultSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(daily.data, notes, teamNames, shotNames, msList) }],
    });
    if (response.stop_reason === "refusal") return json({ error: "Claude declined to process this summary." }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "The answer was cut off. Split the summary and try again." }, 422);
    const parsed = response.parsed_output;
    if (!parsed) return json({ error: "Claude returned no usable task list. Try again." }, 502);
    return json({
      tasks: sanitize(parsed.tasks, teamNames, shotNames, msList),
      model: response.model,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "The Anthropic API key was rejected. Check the ANTHROPIC_API_KEY secret." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Claude is rate-limited right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `Claude API error ${e.status ?? ""}: ${e.message}` }, 502);
    return json({ error: `Could not reach Claude: ${(e as Error).message}` }, 502);
  }
}

// @ts-ignore: Deno exists only in the Edge runtime (tests import handle() directly)
if (typeof Deno !== "undefined") {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req, {
    // @ts-ignore
    env: (name) => Deno.env.get(name),
    supabase: (url, key, auth) => createClient(url, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } }),
    anthropic: (apiKey) => new Anthropic({ apiKey }),
  }));
}
