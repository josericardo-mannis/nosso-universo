// Ponte entre o app e o servidor próprio na Cloudflare.
// Oferece o mesmo window.claude.use("db" | "sample") que o app usava no claude.ai,
// agora apoiado na API /api (D1 para os dados, Anthropic para a Neide).
(() => {
  window.NU_SITE = true;
  const POLL_MS = 10000;
  // Metadados para o app: atividade recente, status do Google e quem sou eu.
  window.NU = { activity: [], google: null, me: null };
  let lastAct = null;
  let cache = {}; // col -> Map(id -> data)
  let loaded = false, sig = "", writeSeq = 0, pending = 0;
  const listeners = new Set();

  async function api(path, opt = {}) {
    const r = await fetch("/api" + path, { ...opt, headers: { "content-type": "application/json" }, credentials: "same-origin" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: body.error?.code || "unavailable", message: body.error?.message || r.statusText };
    return body;
  }
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const snapDoc = (id, d) => ({ id, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } });
  function deliver(l) {
    if (!loaded) return;
    if (l.docId !== undefined) return l.fn(snapDoc(l.docId, cache[l.col]?.get(l.docId)));
    const docs = [...(cache[l.col] || new Map()).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, d]) => snapDoc(id, d));
    l.fn({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
  }
  const emit = () => listeners.forEach(deliver);
  const listen = (l) => { listeners.add(l); deliver(l); return () => listeners.delete(l); };

  async function refresh() {
    try {
      const seq = writeSeq;
      const r = await api("/data");
      if (pending || seq !== writeSeq) return; // uma gravação aconteceu no meio: espera a próxima leitura
      metaUpdate(r);
      const s = JSON.stringify(r.docs);
      if (s === sig && loaded) return;
      sig = s; cache = {};
      for (const d of r.docs) (cache[d.col] ??= new Map()).set(d.id, d.data);
      loaded = true; emit();
    } catch (e) { console.warn("Nosso Universo: falha ao buscar dados", e); }
  }
  function metaUpdate(r) {
    const acts = r.activity || [];
    const newest = acts[0]?.id || 0;
    const metaSig = newest + "|" + JSON.stringify(r.google || {});
    const changed = metaSig !== window.NU._sig;
    // Avisa só o que a OUTRA pessoa fez desde a última leitura (não no primeiro carregamento).
    if (lastAct !== null && newest > lastAct) {
      const novas = acts.filter((a) => a.id > lastAct && a.who !== window.NU.me).reverse();
      for (const a of novas) window.dispatchEvent(new CustomEvent("nu-activity", { detail: a }));
    }
    lastAct = newest;
    window.NU.activity = acts;
    window.NU.google = r.google || null;
    window.NU._sig = metaSig;
    if (changed) window.dispatchEvent(new CustomEvent("nu-meta"));
  }
  window.NU.refresh = () => refresh();
  window.NU.api = api;
  async function write(path, opt) {
    writeSeq++; pending++;
    try { await api(path, opt); } finally { pending--; }
    refresh();
  }
  const docRef = (col, id) => ({
    id, path: col + "/" + id,
    async get() { return snapDoc(id, cache[col]?.get(id)); },
    async set(data) {
      (cache[col] ??= new Map()).set(id, data); emit();
      await write(`/doc/${col}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(data) });
    },
    async update(data) { await this.set({ ...(cache[col]?.get(id) || {}), ...data }); },
    async delete() {
      cache[col]?.delete(id); emit();
      await write(`/doc/${col}/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    onSnapshot(fn) { return listen({ col, docId: id, fn }); },
  });
  const db = {
    collection: (col) => ({
      path: col,
      doc: (id) => docRef(col, id || rid()),
      async add(data) { const ref = docRef(col, rid()); await ref.set(data); return ref; },
      onSnapshot(fn) { return listen({ col, fn }); },
      async get() { return new Promise((res) => { const off = listen({ col, fn: (s) => { off?.(); res(s); } }); }); },
    }),
    doc: (path) => { const [col, id] = path.split("/"); return docRef(col, id); },
  };

  /* Neide: mesmo contrato de sample(), com o laço de ferramentas rodando aqui no navegador. */
  async function sample(input, opts = {}) {
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input.map((m) => ({ ...m }));
    const defs = (opts.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let shown = "";
    for (let turn = 0; turn < 8; turn++) {
      const r = await api("/neide", { method: "POST", body: JSON.stringify({ messages, tools: defs }) });
      if (r.stop_reason === "refusal") throw { code: "refused", message: "A Neide não pode ajudar com isso." };
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) { shown = text; opts.onText?.({ text, delta: text }); }
      const uses = r.content.filter((b) => b.type === "tool_use");
      if (r.stop_reason !== "tool_use" || !uses.length) return { text: text || shown, truncated: r.stop_reason === "max_tokens", modelTierApplied: "default", modelApplied: r.model };
      messages.push({ role: "assistant", content: r.content });
      const results = await Promise.all(uses.map(async (u) => {
        const tool = opts.tools.find((t) => t.name === u.name);
        try {
          if (!tool) throw new Error("ferramenta desconhecida: " + u.name);
          const out = await tool.execute(u.input || {}, { signal: new AbortController().signal });
          return { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out ?? "ok") };
        } catch (e) {
          return { type: "tool_result", tool_use_id: u.id, content: String(e?.message || e), is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
    return { text: shown || "Fiz o que deu e parei aqui para não entrar em loop.", truncated: false, modelTierApplied: "default" };
  }
  sample.json = async (input, opts = {}) => {
    const r = await sample(input, { ...opts, tools: undefined });
    const m = r.text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw { code: "invalid_json", message: "A resposta não veio em JSON." };
    return JSON.parse(m[0]);
  };
  sample.limits = async () => ({ maxPromptBytes: 400000 });

  const ready = (async () => {
    try {
      const me = await api("/me");
      window.NU.me = me.who;
      if (me.who === "a" || me.who === "b") {
        localStorage.setItem("nu.eu", JSON.stringify(me.who));
        localStorage.setItem("mural.me", JSON.stringify(me.who));
      }
    } catch (e) { console.warn("Nosso Universo: sem identificação", e); }
    await refresh();
    setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  })();

  window.claude = {
    async use(name) {
      if (name === "db") { await ready; return loaded ? db : null; }
      if (name === "sample") return sample;
      return null;
    },
  };
})();
