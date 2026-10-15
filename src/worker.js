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

async function handleSample(request, env) {
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
  let model = wanted || TIER[tier];
  let res = await callClaude(env, model, content, maxTokens);
  if (!res.ok && wanted && (res.status === 400 || res.status === 403 || res.status === 404)) {
    model = TIER[tier];
    res = await callClaude(env, model, content, maxTokens);
  }
  if (!res.ok) {
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
      return json(res.truncated
        ? { code: "truncated", message: "The AI's reply was cut off before it finished" }
        : { code: "bad_json", message: "The AI's reply came back in the wrong format" }, 502);
    }
  }
  return json(out);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/sample") return handleSample(request, env);
    if (url.pathname === "/api/health") return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY });
    return env.ASSETS.fetch(request);
  },
};
