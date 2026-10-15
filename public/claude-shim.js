// Connects the Climb app to this site's own server (/api/sample) instead of Claude-in-chat.
// Progress is saved in this browser (localStorage) until accounts are added.
(function () {
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
      headers: { "content-type": "application/json" },
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
})();
