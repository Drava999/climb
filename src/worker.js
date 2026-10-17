// Climb server: serves the app from /public and relays learning-content requests to the Claude API.
// The API key lives only here, as the Cloudflare secret ANTHROPIC_API_KEY.

const MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const TIER = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-opus-5-5" };
// The house style guide. It is identical on every request, so it is sent as a cached prefix (prompt caching).
const SYSTEM = `You are the content engine of Climb, a learning app that takes anyone from complete beginner to expert in any subject through short daily lessons. You write accurate course maps, mini-lessons, practice questions, answer checks and short explanations. Only produce learning content for the request you are given; briefly decline anything unrelated to learning. When asked for JSON, reply with valid JSON only, exactly in the requested shape, with no commentary.

CLIMB HOUSE STYLE (apply to everything you write unless the request says otherwise)

1. Accuracy first. Use the definitions, conventions, units and terminology of the subject, syllabus or exam named in the request. A term means what it means in that subject: "mole" in chemistry, "demurrage" in shipping, "elasticity" in economics. Never blend meanings from other fields. If something is uncertain or disputed, say so briefly rather than inventing.

2. PLAIN-LANGUAGE RULE. The learner knows everyday words plus the course concepts that come BEFORE the one being written about. Any other technical term must be avoided or explained in plain words right where it appears, e.g. "freight rate (the price paid to carry cargo, e.g. USD per tonne)". Never use vague shorthand such as "freight cash". Short sentences. Questions under 25 words where possible, scenarios under 45 words, unless the stage below asks for longer problems.

3. SELF-CONTAINED RULE. Every question, guess and scenario states all the facts needed to answer it, including the reason behind any assumption. Someone who sees only that one question must be able to follow it. Never rely on unstated textbook assumptions. Every "why" explains the cause step by step, using the numbers when there are numbers.

4. ONE ANALOGY PER CONCEPT. Choose one high-quality analogy that mirrors how the concept actually works (cause and effect, not surface), that people anywhere would recognise and that isn't childish. Reuse that same analogy wherever an analogy is asked for; introduce no other. If no analogy fits well, use one concrete real-world example instead.

5. QUALITY OF CONCEPTS. Every concept is specific and testable: a named mechanism, rule, term of art, process, document, formula, number or case that practitioners actually use. Never write filler such as "Introduction to X", "Overview of X", "Why X matters" or "Key terms". Skip what an ordinary educated adult already knows. Prefer depth over breadth. Introduce vocabulary in order: a term may only be used once an earlier concept introduced it or it is explained in brackets on the spot.

6. DIFFICULTY GROWS IN THINKING, NOT ARITHMETIC. Each concept belongs to a stage. Harder means more interacting factors, second-order effects, exceptions, real cases and judgement, never just bigger numbers:
- Foundations: one idea at a time. What it is, why it works, a concrete example, the common misconception.
- Intermediate: how ideas interact. Cause and effect across two or three factors, applying the idea to a new realistic situation, reading a simple table or chart, the standard tools and documents of the field.
- Advanced: second-order effects and chains of consequences, which factor matters most, where the rule breaks down, trade-offs, spotting the flaw in a plausible argument, short case analysis.
- Expert and Frontier: professional judgement with incomplete information, real case studies, competing explanations, critiquing expert claims, predicting novel situations, recent developments and open questions.
Later questions must demand clearly deeper reasoning than earlier ones. Never stay at definition level beyond Foundations.

7. HARD SKILLS AND THINKING MOVES. Every question trains one thinking move: recognise, explain (why or how), apply (to a new situation), analyse (chains of effects, which factor matters most, limits, spot the flaw) or judge (decide with trade-offs and incomplete information, predict, argue a position). Mix the moves; from Intermediate up most questions should explain, analyse or judge. Teach the practical skills a professional actually uses (reading documents, contracts, tables and charts, procedures, estimation), but calculations are a tool, not the goal: in subjects that are not mainly mathematical, at most about one question in three may need a calculation, and every calculation must end in an interpretation or decision ("so which should the owner choose, and why?"). Mainly mathematical subjects (maths, physics, accounting, statistics) may use more, and in pure maths "find" and "show that" questions are fine.

8. EXAM AND UNIVERSITY STYLE. If the request names an exam or a university course, match its question style and command words (State, Explain, Calculate, Evaluate, Discuss), give marks that match the depth asked, and write mark-scheme points one per mark. University style means first-year module rigour: precise definitions, standard frameworks and models, calculations with working, and "discuss/evaluate" questions that reward structure and evidence.

9. NUMBERS. When an answer is a number, make it unambiguous: state units, the rounding expected, and keep figures realistic for the field. Show working in explanations.

10. QUESTION CRAFT. Multiple-choice distractors are plausible, similar in length and style to the right answer, and each reflects a real misconception; never "all of the above". True/false statements are subtly false when false, never trivially. Fill-the-gap removes the key term, not a filler word. Recall questions have exactly one clear correct answer (with a few acceptable wordings). Scenarios are realistic for the field and vary in setting. Open questions name exactly what a strong answer must cover. Every question tests a different angle: mechanism, example, misconception, edge case, comparison, cause and effect, numbers.

11. MARKING. Mark fairly: accept synonyms, alternative valid wording and minor spelling slips; reward correct reasoning even if phrased differently from the reference; give partial credit for a partly right answer; explain the verdict in one short, kind sentence that says what was missing.

12. TONE. Warm, direct, encouraging, never patronising. No emoji. British/Singapore spelling is fine.`;
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
    body: JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] }),
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
  if (p.startsWith("You are planning the full curriculum map")) return "course_map";
  if (p.startsWith("A learner in a course called")) return "explain_term";
  if (p.startsWith("A course called") && prompt.includes("learning PATH")) return "path_text";
  if (p.startsWith("A course called") && prompt.includes("build on knowledge from which")) return "field_links";
  if (p.startsWith("A course called")) return "suggest_fields";
  if (/^Write \d+ higher-order questions/.test(p)) return "combo_questions";
  if (p.startsWith("Mark a learner's answer to a question that combines")) return "combo_mark";
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
  { const over = await checkQuota(request, env); if (over) return over; }

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


// ---------- accounts: Google sign-in, sessions, synced courses, daily quotas ----------
const SESSION_DAYS = 60;
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (t) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(t)));
function cookies(request) {
  const out = {};
  (request.headers.get("cookie") || "").split(";").forEach((p) => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
// Sign-in works with the client ID alone (Google's button + ID-token verification). The secret only enables the optional redirect flow.
const authReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.LOGS);
const redirectReady = (env) => !!(authReady(env) && env.GOOGLE_CLIENT_SECRET);
const sameOrigin = (request) => { const o = request.headers.get("origin"); return !o || new URL(o).host === new URL(request.url).host; };

async function currentUser(request, env) {
  if (!env.LOGS) return null;
  const tok = cookies(request).climb_sess; if (!tok) return null;
  const row = await env.LOGS.prepare("SELECT u.id, u.email, u.name, u.picture, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
    .bind(await sha256(tok)).first().catch(() => null);
  if (!row || Date.parse(row.expires) < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name, picture: row.picture };
}

async function authStart(request, env) {
  if (!redirectReady(env)) return new Response(null, { status: 302, headers: { location: "/?signin=unavailable" } });
  const url = new URL(request.url), state = randToken(16);
  const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  g.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/auth/google/callback`, response_type: "code", scope: "openid email profile", state, prompt: "select_account" }).toString();
  return new Response(null, { status: 302, headers: { location: g.toString(), "set-cookie": cookie("climb_oauth", state, 600) } });
}

async function authCallback(request, env) {
  const url = new URL(request.url), back = (q) => new Response(null, { status: 302, headers: { location: "/" + (q || ""), "set-cookie": cookie("climb_oauth", "", 0) } });
  if (!redirectReady(env)) return back("?signin=unavailable");
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request).climb_oauth) return back("?signin=failed");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code" }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.id_token) return back("?signin=failed");
  // The ID token came straight from Google's token endpoint over TLS in exchange for our secret, so its claims can be read directly.
  let c; try { c = JSON.parse(atob(t.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return back("?signin=failed"); }
  if (c.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(c.iss) || c.exp * 1000 < Date.now() || !c.sub) return back("?signin=failed");
  const h = new Headers({ location: "/?signin=ok" });
  h.append("set-cookie", await startSession(env, c));
  h.append("set-cookie", cookie("climb_oauth", "", 0));
  return new Response(null, { status: 302, headers: h });
}

async function startSession(env, c) {
  const uid = "g:" + c.sub, ts = now();
  await env.LOGS.prepare("INSERT INTO users (id, email, name, picture, created, last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture, last_seen=excluded.last_seen")
    .bind(uid, clip(c.email, 200), clip(c.name || c.given_name || "", 120), clip(c.picture || "", 500), ts, ts).run();
  const tok = randToken();
  await env.LOGS.prepare("INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?,?,?,?)")
    .bind(await sha256(tok), uid, ts, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString()).run();
  return cookie("climb_sess", tok, SESSION_DAYS * 86400);
}

// Google's sign-in button posts an ID token here; we verify its RS256 signature against Google's public keys.
let JWKS = { at: 0, keys: [] };
const b64urlBytes = (t) => Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)), (ch) => ch.charCodeAt(0));
async function googleKeys(force) {
  if (!force && JWKS.keys.length && Date.now() - JWKS.at < 3600e3) return JWKS.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const d = await r.json(); JWKS = { at: Date.now(), keys: d.keys || [] }; return JWKS.keys;
}
async function verifyGoogleIdToken(env, token) {
  const parts = String(token || "").split("."); if (parts.length !== 3) return null;
  let head, claims; try { head = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0]))); claims = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1]))); } catch { return null; }
  if (head.alg !== "RS256") return null;
  let jwk = (await googleKeys()).find((k) => k.kid === head.kid); if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  if (claims.aud !== env.GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) || claims.exp * 1000 < Date.now() || !claims.sub) return null;
  if (claims.email && claims.email_verified === false) return null;
  return claims;
}
async function authToken(request, env) {
  if (request.method !== "POST" || !sameOrigin(request)) return json({ code: "forbidden" }, 403);
  if (!authReady(env)) return json({ code: "unavailable", message: "Sign-in isn't set up yet" }, 503);
  let b; try { b = await request.json(); } catch { return json({ code: "bad_request" }, 400); }
  const claims = await verifyGoogleIdToken(env, b.credential).catch(() => null);
  if (!claims) return json({ code: "invalid", message: "Couldn't verify the Google sign-in" }, 401);
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": await startSession(env, claims) } });
}

async function authLogout(request, env) {
  if (request.method !== "POST" || !sameOrigin(request)) return json({ code: "method" }, 405);
  const tok = cookies(request).climb_sess;
  if (tok && env.LOGS) await env.LOGS.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(tok)).run().catch(() => {});
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": cookie("climb_sess", "", 0) } });
}

async function handleMe(request, env) {
  const user = await currentUser(request, env);
  return json({ auth: authReady(env), clientId: authReady(env) ? env.GOOGLE_CLIENT_ID : null, redirect: redirectReady(env), user });
}

// Per-day AI request quota: signed-in users by account, guests by IP. Returns null when allowed, or an error response.
async function checkQuota(request, env) {
  if (!env.LOGS) return null;
  const user = await currentUser(request, env);
  const key = user ? "u:" + user.id : "ip:" + (request.headers.get("cf-connecting-ip") || "anon");
  const limit = parseInt(user ? env.QUOTA_USER : env.QUOTA_GUEST) || (user ? 400 : 60);
  const day = now().slice(0, 10);
  const row = await env.LOGS.prepare("INSERT INTO usage (key, day, n) VALUES (?,?,1) ON CONFLICT(key, day) DO UPDATE SET n = n + 1 RETURNING n").bind(key, day).first().catch(() => null);
  if (row && row.n > limit) return json({ code: "quota", message: user ? "You've reached today's limit. It resets tomorrow." : "You've reached today's guest limit. Sign in with Google for more, or come back tomorrow." }, 429);
  return null;
}

// Synced storage for signed-in users.
async function handleData(request, env, path) {
  if (!sameOrigin(request)) return json({ code: "forbidden" }, 403);
  const user = await currentUser(request, env);
  if (!user) return json({ code: "signed_out" }, 401);
  const db = env.LOGS, m = request.method;
  if (path === "/api/data/profile") {
    if (m === "GET") { const r = await db.prepare("SELECT json FROM profiles WHERE user_id = ?").bind(user.id).first(); return json({ profile: r ? JSON.parse(r.json) : null }); }
    if (m === "PUT") { const t = await request.text(); if (t.length > 100000) return json({ code: "too_long" }, 413);
      await db.prepare("INSERT INTO profiles (user_id, json, updated) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated=excluded.updated").bind(user.id, t, now()).run(); return json({ ok: true }); }
  }
  if (path === "/api/data/courses" && m === "GET") {
    const r = await db.prepare("SELECT id, json FROM courses WHERE user_id = ?").bind(user.id).all();
    return json({ courses: (r.results || []).map((x) => ({ id: x.id, data: JSON.parse(x.json) })) });
  }
  const mm = path.match(/^\/api\/data\/courses\/([A-Za-z0-9_-]{1,64})$/);
  if (mm) {
    if (m === "PUT") { const t = await request.text(); if (t.length > 1900000) return json({ code: "quota_exceeded", message: "This course is too big to save" }, 413);
      await db.prepare("INSERT INTO courses (user_id, id, updated, json) VALUES (?,?,?,?) ON CONFLICT(user_id, id) DO UPDATE SET updated=excluded.updated, json=excluded.json").bind(user.id, mm[1], Date.now(), t).run(); return json({ ok: true }); }
    if (m === "DELETE") { await db.prepare("DELETE FROM courses WHERE user_id = ? AND id = ?").bind(user.id, mm[1]).run(); return json({ ok: true }); }
  }
  return json({ code: "not_found" }, 404);
}


// ---------- shared library: reuse identical generations across learners ----------
// Only server-generated replies are stored, keyed by a hash of the exact request, so nobody can inject content.
const CACHEABLE = new Set(["scope", "outline", "course_map", "path_text", "field_links", "mini_lesson", "questions", "explain_term", "explain_simpler", "term_example", "suggest_fields", "explain_deeper", "other"]);
const cacheKey = (model, json, prompt) => sha256(`${model}|${json ? 1 : 0}|${prompt}`);
async function cacheGet(env, key) {
  if (!env.LOGS) return null;
  const r = await env.LOGS.prepare("SELECT text FROM gen_cache WHERE key = ?").bind(key).first().catch(() => null);
  if (r) env.LOGS.prepare("UPDATE gen_cache SET hits = hits + 1, last_hit = ? WHERE key = ?").bind(now(), key).run().catch(() => {});
  return r ? r.text : null;
}
function cachePut(env, ctx, key, purpose, model, text) {
  if (!env.LOGS || !text || text.length > 400000) return;
  ctx.waitUntil(env.LOGS.prepare("INSERT OR IGNORE INTO gen_cache (key, purpose, model, created, hits, text) VALUES (?,?,?,?,0,?)").bind(key, purpose, model, now(), text).run().catch(() => {}));
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
  const over = await checkQuota(request, env); if (over) return over;

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
  const canCache = !b.nocache && content.length === 1 && CACHEABLE.has(purpose) && !prompt.includes("SOURCE MATERIAL") && !prompt.includes("already practised these questions");
  const ck = canCache ? await cacheKey(model, !!b.json, prompt) : null;
  if (ck) {
    const hit = await cacheGet(env, ck);
    if (hit) {
      const out = { text: hit, truncated: false, cached: true, modelApplied: wanted || undefined, modelTierApplied: tier };
      if (b.json) { try { out.data = parseJson(hit); } catch { out.data = null; } }
      if (!b.json || out.data) { logGeneration(env, ctx, { device, purpose, model, tier, ms: Date.now() - t0, prompt, ok: true, status: "cache", reply: "" }); return json(out); }
    }
  }
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
  if (ck && !res.truncated && model === (wanted || TIER[tier])) cachePut(env, ctx, ck, purpose, model, res.text);
  return json(out);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sample") return handleSample(request, env, ctx);
    if (url.pathname === "/api/log") return handleLog(request, env, ctx);
    if (url.pathname === "/api/syllabus") return handleSyllabus(request, env, ctx);
    if (url.pathname === "/api/health") return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY, auth: authReady(env) });
    if (url.pathname === "/auth/google/start") return authStart(request, env);
    if (url.pathname === "/auth/google/callback") return authCallback(request, env);
    if (url.pathname === "/auth/logout") return authLogout(request, env);
    if (url.pathname === "/auth/google/token") return authToken(request, env);
    if (url.pathname === "/api/me") return handleMe(request, env);
    if (url.pathname.startsWith("/api/data/")) return handleData(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  },
};
