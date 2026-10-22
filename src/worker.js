// Nosso Universo: API do app dos Gatitos (dados no D1 + Neide via API da Anthropic).
// Os arquivos do site (public/) são servidos direto pela Cloudflare; este Worker só atende /api/*.
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import SEED from "./seed.json";

const COLS = new Set(["ev", "tasks", "bills", "fin", "vend", "wed", "ideas", "watch", "goals", "bday", "config", "answers"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const MAX_DOC_BYTES = 256 * 1024;

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
  return ze.length || ra.length ? null : "ambos"; // sem lista configurada, qualquer login do Access entra
}

/* ---------- preparo do banco ----------
   No primeiro acesso cria a tabela e, se ela estiver vazia, carrega os dados migrados do app no claude.ai.
   Assim ninguém precisa rodar SQL no painel. */
let dbReady = null;
function ensureDb(env) {
  dbReady ??= (async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT, PRIMARY KEY (col, id))",
    ).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated_at)").run();
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
  const { results } = await env.DB.prepare("SELECT col, id, data FROM docs").all();
  return results.map((r) => ({ col: r.col, id: r.id, data: JSON.parse(r.data) }));
}
async function putDoc(env, col, id, data, by) {
  const body = JSON.stringify(data);
  if (body.length > MAX_DOC_BYTES) throw Object.assign(new Error("Documento grande demais"), { status: 413 });
  await env.DB.prepare(
    "INSERT INTO docs (col, id, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  ).bind(col, id, body, Date.now(), by).run();
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
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const email = await identify(request, env);
    if (!email) return fail(401, "not_granted", "Entre pelo login do Cloudflare Access.");
    const who = whoFor(email, env);
    if (!who) return fail(403, "not_granted", "Este e-mail não faz parte do Nosso Universo.");

    const parts = url.pathname.split("/").filter(Boolean).slice(1); // depois de "api"
    try {
      await ensureDb(env);
      if (parts[0] === "me" && request.method === "GET") return json({ email, who });

      if (parts[0] === "data" && request.method === "GET") return json({ docs: await allDocs(env), now: Date.now() });

      if (parts[0] === "doc") {
        const [, col, rawId] = parts;
        const id = rawId && decodeURIComponent(rawId);
        if (!COLS.has(col)) return fail(400, "invalid_argument", "Coleção desconhecida.");
        if (request.method === "POST" && !id) {
          const newId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
          await putDoc(env, col, newId, await request.json(), email);
          return json({ id: newId });
        }
        if (!id || !ID_RE.test(id)) return fail(400, "invalid_argument", "Id inválido.");
        if (request.method === "PUT") {
          const data = await request.json().catch(() => null);
          if (!data || typeof data !== "object" || Array.isArray(data)) return fail(400, "invalid_argument", "Corpo precisa ser um objeto JSON.");
          await putDoc(env, col, id, data, email);
          return json({ ok: true });
        }
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM docs WHERE col = ?1 AND id = ?2").bind(col, id).run();
          return json({ ok: true });
        }
      }

      if (parts[0] === "neide" && request.method === "POST") return neide(request, env);

      return fail(404, "not_found", "Rota não encontrada.");
    } catch (err) {
      if (err.status === 413) return fail(413, "invalid_argument", err.message);
      console.error(err);
      return fail(500, "unavailable", "Erro inesperado no servidor.");
    }
  },
};
