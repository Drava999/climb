// Connects the Climb app to this site's own server (/api/sample) instead of Claude-in-chat.
// Progress is saved in this browser (localStorage) until accounts are added.
(function () {
  // Anonymous device id (random, stored in this browser) so logs from one learner can be followed.
  const DEVICE = (() => {
    try {
      let d = localStorage.getItem("climb_device");
      if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)); localStorage.setItem("climb_device", d); }
      return d;
    } catch (e) { return "nostore-" + Math.random().toString(36).slice(2, 10); }
  })();

  // Interaction log: batched to /api/log every few seconds and when the page is hidden.
  const queue = [];
  function flush(beacon) {
    if (!queue.length) return;
    const body = JSON.stringify({ device: DEVICE, events: queue.splice(0, 100) });
    try {
      if (beacon && navigator.sendBeacon && navigator.sendBeacon("/api/log", new Blob([body], { type: "text/plain" }))) return;
      fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
    } catch (e) {}
  }
  window.climbLog = (kind, o) => {
    o = o || {};
    queue.push({ ts: new Date().toISOString(), kind, course: o.course || null, concept: o.concept || null, data: o.data || {} });
    if (queue.length >= 25) flush(false);
  };
  setInterval(() => flush(false), 8000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("error", (e) => window.climbLog("js_error", { data: { message: String(e.message || ""), where: (e.filename || "") + ":" + (e.lineno || "") } }));

  function shrinkImage(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const max = 1568, scale = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        resolve({ type: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.85).split(",")[1] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  async function call(prompt, opts, wantJson) {
    opts = opts || {};
    const text = typeof prompt === "string" ? prompt
      : Array.isArray(prompt) ? prompt.map((m) => (m.role === "assistant" ? "Assistant: " : "") + m.content).join("\n\n") : String(prompt);
    const images = opts.images && opts.images.length ? (await Promise.all([...opts.images].slice(0, 6).map(shrinkImage))).filter(Boolean) : [];
    const r = await fetch("/api/sample", {
      method: "POST",
      headers: { "content-type": "application/json", "x-climb-device": DEVICE },
      body: JSON.stringify({ prompt: text, json: !!wantJson, modelTier: opts.modelTier || "default", model: opts.model || null, images }),
      signal: opts.signal,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.message || "Something went wrong");
      e.code = d.code || (r.status === 429 ? "rate_limited" : "error");
      throw e;
    }
    return d;
  }

  const sample = async (prompt, opts) => {
    const d = await call(prompt, opts, false);
    if (opts && typeof opts.onText === "function") { try { opts.onText({ text: d.text, delta: d.text }); } catch (e) {} }
    return { text: d.text, truncated: !!d.truncated, modelApplied: d.modelApplied, modelTierApplied: d.modelTierApplied };
  };
  sample.json = async (prompt, opts) => (await call(prompt, opts, true)).data;
  sample.limits = async () => ({ images: true });

  window.claude = { use: async (name) => (name === "sample" ? sample : null) };

  // Official syllabus lookup (SEAB, Singapore). Cached on the server after the first lookup.
  window.climbSyllabus = async (exam, subject, year) => {
    const r = await fetch("/api/syllabus", {
      method: "POST",
      headers: { "content-type": "application/json", "x-climb-device": DEVICE },
      body: JSON.stringify({ exam, subject, year }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.message || "Syllabus lookup failed"); e.code = d.code || "error"; throw e; }
    return d;
  };
})();
