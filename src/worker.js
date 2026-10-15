// Climb server: serves the app from /public and relays learning-content requests to the Claude API.
// The API key lives only here, as the Cloudflare secret ANTHROPIC_API_KEY.

const MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const TIER = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
const SYSTEM =
  "You are the content engine of Climb, a learning app. You write accurate course outlines, mini-lessons, " +
  "practice questions, answer checks and short explanations for learners. Only produce learning content for " +
  "the request you are given; briefly decline anything unrelated to learning.";
const MAX_PROMPT = 60000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function parseJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no json");
  return JSON.parse(s.slice(a, b + 1));
}

async function callClaude(env, model, content, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, message: (d.error && d.error.message) || "Claude API error" };
  const text = (d.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
  return { ok: true, text, truncated: d.stop_reason === "max_tokens" };
}

// ---------- logging (Cloudflare D1, binding LOGS) ----------
const now = () => new Date().toISOString();
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
function purposeOf(prompt) {
  const p = prompt.slice(0, 200);
  if (p.startsWith("A learner wants to learn")) return "scope";
  if (p.startsWith("You are an expert teacher designing")) return "outline";
  if (p.startsWith("You are a brilliant teacher turning")) return "mini_lesson";
  if (p.startsWith("Write practice questions")) return prompt.includes("already practised these questions") ? "questions_refill" : "questions";
  if (p.startsWith("You are extending a course")) return "branch";
  if (p.startsWith("Judge whether a learner")) return "answer_check";
  if (p.startsWith("Mark a learner's open answer")) return "open_answer_mark";
  if (p.startsWith("A learner studying")) return "explain_deeper";
  if (p.startsWith("Explain \"")) return "explain_simpler";
  if (p.startsWith("In a course called")) return "term_example";
  return "other";
}
function logGeneration(env, ctx, row) {
  if (!env.LOGS) return;
  ctx.waitUntil(env.LOGS.prepare(
    "INSERT INTO generations (ts, device, purpose, model, tier, ok, status, ms, truncated, prompt, reply, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(now(), clip(row.device, 64), row.purpose, row.model, row.tier, row.ok ? 1 : 0, String(row.status || ""), row.ms | 0,
         row.truncated ? 1 : 0, clip(row.prompt, 200000), clip(row.reply, 200000), clip(row.error, 2000)).run().catch(() => {}));
}

async function handleLog(request, env, ctx) {
  if (request.method !== "POST") return json({ code: "method" }, 405);
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ code: "forbidden" }, 403);
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  if (env.RL_LOG) { const { success } = await env.RL_LOG.limit({ key: ip }); if (!success) return json({ ok: false }, 429); }
  if (!env.LOGS) return json({ ok: false });
  const raw = await request.text();
  if (raw.length > 200000) return json({ code: "too_long" }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ code: "bad_request" }, 400); }
  const events = Array.isArray(b.events) ? b.events.slice(0, 100) : [];
  if (!events.length) return json({ ok: true, n: 0 });
  const stmt = env.LOGS.prepare("INSERT INTO events (ts, device, kind, course, concept, data) VALUES (?,?,?,?,?,?)");
  const batch = events.filter((e) => e && e.kind).map((e) =>
    stmt.bind(clip(e.ts, 40) || now(), clip(b.device, 64), clip(e.kind, 40), clip(e.course, 200), clip(e.concept, 200), clip(JSON.stringify(e.data || {}), 20000)));
  ctx.waitUntil(env.LOGS.batch(batch).catch(() => {}));
  return json({ ok: true, n: batch.length });
}

// ---------- official syllabus lookup (Singapore exams) ----------
const SG_EXAMS = { psle: "PSLE", sec: "SEC (Singapore-Cambridge Secondary Education Certificate)", olevel: "GCE O-Level", nalevel: "GCE N(A)-Level", ntlevel: "GCE N(T)-Level", alevel: "GCE A-Level" };
const SYL_DOMAINS = ["seab.gov.sg", "www.seab.gov.sg", "isomer-user-content.by.gov.sg", "moe.gov.sg", "www.moe.gov.sg"];
const SYL_TTL_DAYS = 60;

async function claudeWithTools(env, body) {
  // Server tools can pause long turns; continue up to 4 times.
  const messages = body.messages.slice();
  let last;
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ ...body, messages }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, message: (d.error && d.error.message) || "Claude API error" };
    last = d;
    if (d.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: d.content });
  }
  const text = (last.content || []).filter((x) => x.type === "text").map((x) => x.text).join("");
  const searches = (last.usage && last.usage.server_tool_use) || {};
  return { ok: true, text, truncated: last.stop_reason === "max_tokens", searches };
}

async function handleSyllabus(request, env, ctx) {
  if (request.method !== "POST") return json({ code: "method" }, 405);
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ code: "forbidden", message: "Not allowed" }, 403);
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  if (env.RL_BURST) { const { success } = await env.RL_BURST.limit({ key: ip }); if (!success) return json({ code: "rate_limited", message: "Too many requests. Wait a minute and try again." }, 429); }
  if (!env.ANTHROPIC_API_KEY) return json({ code: "not_configured", message: "The site isn't connected to Claude yet." }, 500);

  let b; try { b = await request.json(); } catch { return json({ code: "bad_request" }, 400); }
  const exam = SG_EXAMS[b.exam];
  const subject = String(b.subject || "").trim().slice(0, 80);
  if (!exam || !subject) return json({ code: "bad_request", message: "Choose an exam and a subject." }, 400);
  const year = /^\d{4}$/.test(String(b.year)) ? String(b.year) : String(new Date().getFullYear());
  const key = `${b.exam}|${subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${year}`;

  if (env.LOGS) {
    const row = await env.LOGS.prepare("SELECT ts, json FROM syllabi WHERE key = ?").bind(key).first().catch(() => null);
    if (row && Date.now() - Date.parse(row.ts) < SYL_TTL_DAYS * 864e5) {
      try { return json({ cached: true, syllabus: JSON.parse(row.json) }); } catch {}
    }
  }

  const prompt = `Find the official ${exam} syllabus for "${subject}" for examinations in ${year}, published by SEAB (Singapore Examinations and Assessment Board).
Steps:
1. Search seab.gov.sg for the ${exam} syllabuses page for ${year} (school candidates).
2. Open that page and find this subject's syllabus. Choose the standard version (not private-candidate, not a different language medium) unless the subject name asks for a variant.${b.exam === "sec" ? " SEC subjects are offered at G1, G2 and G3 levels: use G3 unless the subject name says G1 or G2." : ""} If the ${year} page isn't available, use the most recent year and say so in "notes".
3. Fetch the syllabus PDF and read it carefully.
Then return ONLY JSON:
{"found": true, "exam": "${exam}", "subject": "official subject title", "code": "syllabus code", "year": "year it applies to", "source_url": "the PDF URL", "page_url": "the listing page URL",
 "assessment": [{"paper": "", "duration": "", "marks": "", "weighting": "", "format": "one sentence on the question types"}],
 "command_words": ["up to 12 command words used in questions, e.g. State, Explain, Calculate"],
 "topics": [{"title": "topic or theme title", "outcomes": ["up to 6 short learning outcomes in plain words"]}],
 "notes": "one sentence on anything important, e.g. a practical exam or set texts"}
Include every topic area in syllabus order (max 25 topics). If you cannot find the syllabus, return {"found": false, "reason": "why"}.`;

  const t0 = Date.now();
  const res = await claudeWithTools(env, {
    model: "claude-sonnet-5-5",
    max_tokens: 12000,
    system: "You research official Singapore exam syllabuses accurately. Only use information from the official documents you open.",
    messages: [{ role: "user", content: prompt }],
    tools: [
      { type: "web_search_20250305", name: "web_search", max_uses: 4, allowed_domains: SYL_DOMAINS, user_location: { type: "approximate", country: "SG", timezone: "Asia/Singapore" } },
      { type: "web_fetch_20250910", name: "web_fetch", max_uses: 4, allowed_domains: SYL_DOMAINS },
    ],
  });
  const device = request.headers.get("x-climb-device") || null;
  const logBase = { device, purpose: "syllabus", model: "claude-sonnet-5-5", tier: "default", ms: Date.now() - t0, prompt };
  if (!res.ok) {
    logGeneration(env, ctx, { ...logBase, ok: false, status: res.status, error: res.message });
    return json({ code: "upstream", message: res.message }, 502);
  }
  let data;
  try { data = parseJson(res.text); } catch {
    logGeneration(env, ctx, { ...logBase, ok: false, status: "bad_json", truncated: res.truncated, reply: res.text });
    return json({ code: "bad_json", message: "Couldn't read the syllabus" }, 502);
  }
  logGeneration(env, ctx, { ...logBase, ok: !!data.found, status: data.found ? 200 : "not_found", reply: res.text });
  if (!data.found) return json({ code: "not_found", message: data.reason || "No official syllabus found" }, 404);
  const sourceOk = /^https:\/\/([a-z0-9-]+\.)*(gov\.sg)\//i.test(String(data.source_url || ""));
  if (!sourceOk) return json({ code: "not_found", message: "Couldn't confirm an official source" }, 404);
  if (env.LOGS) {
    ctx.waitUntil(env.LOGS.prepare("INSERT OR REPLACE INTO syllabi (key, ts, exam, subject, year, source, json) VALUES (?,?,?,?,?,?,?)")
      .bind(key, now(), exam, String(data.subject || subject), String(data.year || year), String(data.source_url), JSON.stringify(data)).run().catch(() => {}));
  }
  return json({ cached: false, syllabus: data });
}

async function handleSample(request, env, ctx) {
  if (request.method !== "POST") return json({ code: "method", message: "Use POST" }, 405);

  // Only this site's own pages may call the API.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ code: "forbidden", message: "Not allowed" }, 403);

  // Per-visitor limits: a burst limit per minute and a slower hourly-ish limit via the 60s window.
  const ip = request.headers.get("cf-connecting-ip") || "anon";
  if (env.RL_BURST) {
    const { success } = await env.RL_BURST.limit({ key: ip });
    if (!success) return json({ code: "rate_limited", message: "Too many requests. Wait a minute and try again." }, 429);
  }

  if (!env.ANTHROPIC_API_KEY) return json({ code: "not_configured", message: "The site isn't connected to Claude yet (missing API key)." }, 500);

  let b;
  try { b = await request.json(); } catch { return json({ code: "bad_request", message: "Bad request" }, 400); }
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  if (!prompt) return json({ code: "bad_request", message: "Missing prompt" }, 400);
  if (prompt.length > MAX_PROMPT) return json({ code: "too_long", message: "That's too much text. Try shorter notes." }, 413);

  const tier = TIER[b.modelTier] ? b.modelTier : "default";
  const wanted = MODELS.has(b.model) ? b.model : null;

  const content = [];
  for (const im of Array.isArray(b.images) ? b.images.slice(0, 6) : []) {
    if (im && /^image\/(jpeg|png|webp|gif)$/.test(im.type) && typeof im.data === "string" && im.data.length < 7_000_000) {
      content.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } });
    }
  }
  content.push({ type: "text", text: b.json ? `${prompt}\n\nReply with valid JSON only, no other text.` : prompt });

  // Generous ceilings: course outlines, lessons and question sets are long. Billing is per token actually written.
  const maxTokens = tier === "quick" && !b.json ? 2048 : 16000;
  const device = request.headers.get("x-climb-device") || null;
  const purpose = purposeOf(prompt);
  const t0 = Date.now();
  let model = wanted || TIER[tier];
  let res = await callClaude(env, model, content, maxTokens);
  if (!res.ok && wanted && (res.status === 400 || res.status === 403 || res.status === 404)) {
    model = TIER[tier];
    res = await callClaude(env, model, content, maxTokens);
  }
  const logBase = { device, purpose, model, tier, ms: Date.now() - t0, prompt: (content.length > 1 ? `[${content.length - 1} image(s)]\n` : "") + prompt };
  if (!res.ok) {
    logGeneration(env, ctx, { ...logBase, ok: false, status: res.status, error: res.message });
    const code = res.status === 429 ? "rate_limited" : res.status === 529 ? "overloaded" : "upstream";
    return json({ code, message: res.status === 429 ? "Claude is busy right now. Try again in a minute." : res.message }, res.status === 429 ? 429 : 502);
  }

  const out = {
    text: res.text,
    truncated: res.truncated,
    modelApplied: wanted && model === wanted ? wanted : undefined,
    modelTierApplied: Object.keys(TIER).find((t) => TIER[t] === model) || tier,
  };
  if (b.json) {
    try { out.data = parseJson(res.text); }
    catch {
      logGeneration(env, ctx, { ...logBase, ok: false, status: res.truncated ? "truncated" : "bad_json", truncated: res.truncated, reply: res.text });
      return json(res.truncated
        ? { code: "truncated", message: "The AI's reply was cut off before it finished" }
        : { code: "bad_json", message: "The AI's reply came back in the wrong format" }, 502);
    }
  }
  logGeneration(env, ctx, { ...logBase, ok: true, status: 200, truncated: res.truncated, reply: res.text });
  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sample") return handleSample(request, env, ctx);
    if (url.pathname === "/api/log") return handleLog(request, env, ctx);
    if (url.pathname === "/api/syllabus") return handleSyllabus(request, env, ctx);
    if (url.pathname === "/api/health") return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY });
    return env.ASSETS.fetch(request);
  },
};
