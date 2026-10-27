// Nosso Universo: API do app dos Gatitos (dados no D1, Neide via API da Anthropic, Google Agenda e rotinas).
// Os arquivos do site (public/) são servidos direto pela Cloudflare; este Worker atende /api/* e o agendador.
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import SEED from "./seed.json";
import {
  googleConfigured, googleStatus, startConnect, finishConnect, disconnect,
  pullCalendars, mirrorEvent, deleteMirror, MIRROR_FIELDS, todayBR,
} from "./google.js";
import { runRoutine } from "./routines.js";
import { ensureBridge, bridgeInfo, runBridge } from "./bridge.js";

const COLS = new Set(["ev", "tasks", "bills", "fin", "vend", "wed", "ideas", "watch", "goals", "bday", "config", "answers"]);
const READ_ONLY = new Set(["gcal", "brief"]); // preenchidas pelo servidor, o app só lê
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const MAX_DOC_BYTES = 256 * 1024;
const SYNC_EVERY = 5 * 60 * 1000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, code, message) => json({ error: { code, message } }, status);

/* ---------- quem está pedindo (Cloudflare Access) ---------- */
let jwks = null;
async function identify(request, env) {
  // Só para rodar no computador (arquivo .dev.vars). Nunca configure DEV_EMAIL em produção.
  if (env.DEV_EMAIL) return env.DEV_EMAIL.toLowerCase();
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  jwks ??= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: env.ACCESS_AUD });
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}
function whoFor(email, env) {
  const ze = (env.EMAIL_ZE || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const ra = (env.EMAIL_RAQUEL || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  if (ze.includes(email)) return "a";
  if (ra.includes(email)) return "b";
  return null; // fora da lista (ou lista ainda não configurada): ninguém entra
}

/* ---------- preparo do banco ----------
   No primeiro acesso cria as tabelas e, se "docs" estiver vazia, carrega os dados migrados do app no claude.ai.
   Assim ninguém precisa rodar SQL no painel. */
let dbReady = null;
function ensureDb(env) {
  dbReady ??= (async () => {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (col, id))"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, who TEXT, col TEXT, doc TEXT, acao TEXT, titulo TEXT)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
    ]);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs").first();
    if (!row.n) {
      const now = Date.now();
      const insert = env.DB.prepare("INSERT OR IGNORE INTO docs (col, id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, 'migracao')");
      await env.DB.batch(SEED.map((d) => insert.bind(d.col, d.id, JSON.stringify(d.data), now)));
    }
  })().catch((err) => { dbReady = null; throw err; });
  return dbReady;
}

/* ---------- dados ---------- */
async function allDocs(env) {
  const { results } = await env.DB.prepare("SELECT col, id, data FROM docs ORDER BY col, id").all();
  return results.map((r) => ({ col: r.col, id: r.id, data: JSON.parse(r.data) }));
}
async function getDoc(env, col, id) {
  const r = await env.DB.prepare("SELECT data FROM docs WHERE col = ?1 AND id = ?2").bind(col, id).first();
  return r ? JSON.parse(r.data) : null;
}
async function putDoc(env, col, id, data, by) {
  const body = JSON.stringify(data);
  if (body.length > MAX_DOC_BYTES) throw Object.assign(new Error("Documento grande demais"), { status: 413 });
  await env.DB.prepare(
    "INSERT INTO docs (col, id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  ).bind(col, id, body, Date.now(), by).run();
}

/* ---------- registro de atividade: quem fez o quê ---------- */
const titleOf = (d, id) => String(d?.titulo || d?.nome || d?.desc || d?.texto || id).slice(0, 120);
function describe(col, prev, next) {
  if (!prev) return { answers: "respondeu no mural:", config: "mudou os ajustes" }[col] || "adicionou";
  if (!next) return "apagou";
  const hoje = todayBR();
  if (col === "tasks") {
    if (next.tipo === "unica" && next.feito && !prev.feito) return "concluiu";
    if (next.ultima === hoje && prev.ultima !== hoje) return "fez";
    if (prev.ultima === hoje && next.ultima !== hoje) return "desmarcou";
  }
  if (col === "bills" && (next.pagos || []).length > (prev.pagos || []).length) return "pagou";
  if (col === "vend") {
    const pagas = (v) => (v.parcelas || []).filter((p) => p.pago).length;
    if (pagas(next) > pagas(prev)) return "pagou parcela de";
  }
  if (col === "wed" && next.status === "feito" && prev.status !== "feito") return "concluiu no casório:";
  if (col === "watch" && next.status === "visto" && prev.status !== "visto") return "assistiu";
  if (col === "ideas" && JSON.stringify(next.votos || {}) !== JSON.stringify(prev.votos || {})) return "curtiu a ideia";
  if (col === "goals" && (next.checkins || []).length !== (prev.checkins || []).length) return "fez check-in de";
  if (col === "answers") return "atualizou no mural:";
  if (col === "config") return "mudou os ajustes";
  return "editou";
}
async function logActivity(env, who, col, id, acao, titulo) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO activity (ts, who, col, doc, acao, titulo) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(Date.now(), who, col, id, acao, titulo),
    env.DB.prepare("DELETE FROM activity WHERE id <= (SELECT MAX(id) - 1000 FROM activity)"),
  ]);
}
async function recentActivity(env) {
  const { results } = await env.DB.prepare("SELECT id, ts, who, col, doc, acao, titulo FROM activity ORDER BY id DESC LIMIT 40").all();
  return results;
}

/* ---------- gravação de um documento pelo app ---------- */
async function writeDoc(env, ctx, col, id, data, email, who) {
  const prev = await getDoc(env, col, id);
  if (col === "ev" && prev?.gid && !data.gid) { data.gid = prev.gid; data.gcalId = prev.gcalId || ""; } // não perder o vínculo com o Google
  if (prev && JSON.stringify(prev) === JSON.stringify(data)) return;
  await putDoc(env, col, id, data, email);
  await logActivity(env, who, col, id, describe(col, prev, data), titleOf(data, id));
  if (col === "ev") {
    const changed = !prev || MIRROR_FIELDS.some((k) => (prev[k] ?? "") !== (data[k] ?? ""));
    if (changed) ctx.waitUntil(syncEvent(env, id).catch((err) => console.error("espelhar evento", err)));
  }
}
async function syncEvent(env, id) {
  const cur = await getDoc(env, "ev", id);
  if (!cur) return;
  const res = await mirrorEvent(env, id, cur);
  if (res && "gid" in res) {
    const now = await getDoc(env, "ev", id);
    if (now) await putDoc(env, "ev", id, { ...now, gid: res.gid, gcalId: res.gcalId || "" }, "google");
  }
}

/* ---------- rodada de 5 minutos: Google Agenda + ponte com o Instinct ---------- */
async function syncRound(env, maxPedidos) {
  const cfg = (await getDoc(env, "config", "casal")) || {};
  const res = await pullCalendars(env, cfg);
  const pend = [];
  const fakeCtx = { waitUntil: (p) => pend.push(p) };
  const store = { write: (col, id, data) => writeDoc(env, fakeCtx, col, id, data, "instinct", "i") };
  const bridge = await runBridge(env, store, maxPedidos).catch((err) => ({ ok: false, erro: String(err) }));
  await Promise.allSettled(pend);
  return { ...res, bridge };
}

/* ---------- Neide ---------- */
async function neide(request, env) {
  if (!env.ANTHROPIC_API_KEY) return fail(503, "sampling_disabled", "A chave da Anthropic ainda não foi cadastrada no painel da Cloudflare.");
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return fail(400, "invalid_request", "Mensagens ausentes.");
  const tools = Array.isArray(body.tools)
    ? body.tools.slice(0, 12).map((t) => ({ name: String(t.name), description: String(t.description || ""), input_schema: t.input_schema || { type: "object", properties: {} } }))
    : undefined;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.create({
      model: env.NEIDE_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: env.NEIDE_EFFORT || "low" },
      cache_control: { type: "ephemeral" },
      ...(typeof body.system === "string" && body.system ? { system: body.system } : {}),
      messages: body.messages,
      ...(tools && tools.length ? { tools } : {}),
    });
    return json(response);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return fail(429, "rate_limited", "Muitas mensagens seguidas. Tentem em um minuto.");
    if (err instanceof Anthropic.AuthenticationError) return fail(502, "sampling_disabled", "A chave da Anthropic foi recusada. Confiram o segredo ANTHROPIC_API_KEY.");
    if (err instanceof Anthropic.APIError) return fail(502, "upstream_error", err.message);
    throw err;
  }
}

/* ---------- roteamento ---------- */
async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const email = await identify(request, env);
  if (!email) return fail(401, "not_granted", "Entre pelo login do Cloudflare Access.");
  const who = whoFor(email, env);
  if (!who) return fail(403, "not_granted", "Este e-mail não faz parte do Nosso Universo.");

  const parts = url.pathname.split("/").filter(Boolean).slice(1); // depois de "api"
  await ensureDb(env);
  if (parts[0] === "me" && request.method === "GET") return json({ email, who });

  if (parts[0] === "data" && request.method === "GET") {
    const [docs, activity, google] = await Promise.all([allDocs(env), recentActivity(env), googleStatus(env)]);
    // Reserva para o agendador: com o app aberto, sincroniza (e convida a Raquel) no máximo a cada 5 min.
    const now = Date.now();
    if (google.connected && !(google.sync?.at > now - SYNC_EVERY)) {
      const claim = await env.DB.prepare(
        "INSERT INTO kv (k, v) VALUES ('sync_claim', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE CAST(kv.v AS INTEGER) < ?2",
      ).bind(String(now), now - SYNC_EVERY).run();
      if (claim.meta.changes) ctx.waitUntil(syncRound(env, 1).catch((err) => console.error("sync", err)));
    }
    const b = await bridgeInfo(env);
    const instinct = b ? { url: b.url, last: b.last || null } : null;
    return json({ docs, activity, google, instinct, now });
  }

  if (parts[0] === "doc") {
    const [, col, rawId] = parts;
    const id = rawId ? decodeURIComponent(rawId) : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    if (READ_ONLY.has(col)) return fail(400, "invalid_argument", "Esta coleção é preenchida automaticamente.");
    if (!COLS.has(col)) return fail(400, "invalid_argument", "Coleção desconhecida.");
    if (!ID_RE.test(id)) return fail(400, "invalid_argument", "Id inválido.");
    if (request.method === "PUT" || (request.method === "POST" && !rawId)) {
      const data = await request.json().catch(() => null);
      if (!data || typeof data !== "object" || Array.isArray(data)) return fail(400, "invalid_argument", "Corpo precisa ser um objeto JSON.");
      await writeDoc(env, ctx, col, id, data, email, who);
      return json({ ok: true, id });
    }
    if (request.method === "DELETE") {
      const prev = await getDoc(env, col, id);
      await env.DB.prepare("DELETE FROM docs WHERE col = ?1 AND id = ?2").bind(col, id).run();
      if (prev) {
        await logActivity(env, who, col, id, "apagou", titleOf(prev, id));
        if (col === "ev" && prev.gid) ctx.waitUntil(deleteMirror(env, prev.gid, prev.gcalId).catch(() => {}));
      }
      return json({ ok: true });
    }
  }

  if (parts[0] === "google") {
    if (!googleConfigured(env)) return fail(503, "not_configured", "Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no painel da Cloudflare.");
    if (parts[1] === "connect" && request.method === "GET") {
      if (who !== "a") return fail(403, "not_granted", "Quem conecta a Google Agenda é o Zé (conta do Workspace).");
      return startConnect(env, url.origin);
    }
    if (parts[1] === "callback" && request.method === "GET") return finishConnect(env, url.origin, url);
    if (parts[1] === "sync" && request.method === "POST") return json(await syncRound(env, 2));
    if (parts[1] === "disconnect" && request.method === "POST") {
      if (who !== "a") return fail(403, "not_granted", "Só o Zé pode desconectar.");
      await disconnect(env);
      return json({ ok: true });
    }
  }

  if (parts[0] === "instinct" && parts[1] === "planilha" && request.method === "POST") {
    if (who !== "a") return fail(403, "not_granted", "Quem cria a planilha é o Zé (ela fica no Drive dele).");
    try {
      const info = await ensureBridge(env);
      const last = await runBridge(env, { write: (col, id, data) => writeDoc(env, ctx, col, id, data, "instinct", "i") });
      return json({ url: info.url, last });
    } catch (err) {
      if (err.status === 403 || err.status === 401) return fail(403, "not_granted", "O Google recusou: ative a Google Sheets API no projeto e reconecte o Google aceitando a nova permissão.");
      throw err;
    }
  }

  if (parts[0] === "rotina" && request.method === "POST" && ["dia", "semana", "mes"].includes(parts[1])) {
    return json(await runRoutine(env, parts[1], putDoc));
  }

  if (parts[0] === "neide" && request.method === "POST") return neide(request, env);

  return fail(404, "not_found", "Rota não encontrada.");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, ctx);
    } catch (err) {
      if (err.status === 413) return fail(413, "invalid_argument", err.message);
      console.error(err);
      return fail(500, "unavailable", "Erro inesperado no servidor.");
    }
  },

  // Agendador (horários em UTC; São Paulo = UTC-3): ver "triggers" em wrangler.jsonc.
  async scheduled(event, env, ctx) {
    await ensureDb(env);
    const mark = (extra) => env.DB.prepare("INSERT INTO kv (k, v) VALUES ('cron_last', ?1) ON CONFLICT (k) DO UPDATE SET v = excluded.v")
      .bind(JSON.stringify({ cron: event.cron, at: Date.now(), ...extra })).run().catch(() => {});
    await mark({ fase: "inicio" });
    const job = {
      "*/5 * * * *": () => syncRound(env),
      "30 10 * * *": () => runRoutine(env, "dia", putDoc),
      "0 22 * * 0": () => runRoutine(env, "semana", putDoc),
      "0 11 1 * *": () => runRoutine(env, "mes", putDoc),
    }[event.cron];
    if (!job) return mark({ fase: "sem rotina para este horário" });
    ctx.waitUntil(job().then(() => mark({ fase: "ok" })).catch((err) => { console.error("rotina", event.cron, err); return mark({ fase: "erro", erro: String(err?.stack || err).slice(0, 800) }); }));
  },
};
