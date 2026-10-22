// Google Agenda + Gmail, pela conta Google do Zé (app OAuth interno do Workspace mannis.com.br).
// - Puxa os eventos da agenda do Zé e da agenda da Raquel (compartilhada com o Zé) para a coleção "gcal".
// - Espelha os eventos criados no app na agenda do Zé e convida a Raquel quando o evento é "dos dois".
// - Envia o recado diário por e-mail (Gmail) quando ligado.
import { decodeJwt } from "jose";

export const TZ = "America/Sao_Paulo";
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.app.created", // criar e cuidar da agenda "Gatitos"
  "https://www.googleapis.com/auth/gmail.send",
];
const API = "https://www.googleapis.com/calendar/v3";
const DAY_MS = 864e5;

/* ---------- guarda de chaves (tabela kv, nunca exposta pela API de dados) ---------- */
export async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k = ?1").bind(k).first();
  return r ? JSON.parse(r.v) : null;
}
export async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run();
}
export async function kvDel(env, k) {
  await env.DB.prepare("DELETE FROM kv WHERE k = ?1").bind(k).run();
}

/* ---------- datas no fuso de São Paulo ---------- */
const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function brParts(date) {
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const todayBR = () => brParts(new Date()).date;
const pad = (n) => String(n).padStart(2, "0");
function addMinutesLocal(date, hora, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hora.split(":").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + minutes));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}
function nextDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/* ---------- conexão OAuth ---------- */
export const googleConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export async function startConnect(env, origin) {
  const state = crypto.randomUUID();
  await kvSet(env, "google_state", { state, ts: Date.now() });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/google/callback`,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
}

export async function finishConnect(env, origin, url) {
  const back = (msg) => Response.redirect(`${origin}/?google=${encodeURIComponent(msg)}#ajustes`, 302);
  if (url.searchParams.get("error")) return back("cancelado");
  const saved = await kvGet(env, "google_state");
  await kvDel(env, "google_state");
  if (!saved || saved.state !== url.searchParams.get("state") || Date.now() - saved.ts > 10 * 60 * 1000) return back("expirou");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code") || "",
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) return back("falhou");
  let email = "";
  try { email = String(decodeJwt(j.id_token).email || "").toLowerCase(); } catch {}
  await kvSet(env, "google", { refresh_token: j.refresh_token, email, scope: j.scope || "", connected_at: Date.now() });
  cached = { token: null, exp: 0, rt: null };
  return back("conectado");
}

export async function disconnect(env) {
  const g = await kvGet(env, "google");
  if (g?.refresh_token) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(g.refresh_token)}`, { method: "POST" }).catch(() => {});
  await kvDel(env, "google");
  await kvDel(env, "google_sync");
  await env.DB.prepare("DELETE FROM docs WHERE col = 'gcal'").run();
  cached = { token: null, exp: 0, rt: null };
}

export async function googleStatus(env) {
  const g = await kvGet(env, "google");
  const sync = await kvGet(env, "google_sync");
  return {
    configured: googleConfigured(env),
    connected: !!g && !g.broken,
    broken: !!g?.broken,
    email: g?.email || "",
    email_on: !!g && (g.scope || "").includes("gmail.send"),
    sync,
  };
}

let cached = { token: null, exp: 0, rt: null };
async function accessToken(env) {
  const g = await kvGet(env, "google");
  if (!g || g.broken) return null;
  if (cached.token && cached.rt === g.refresh_token && cached.exp > Date.now() + 60_000) return cached.token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: g.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "invalid_grant") await kvSet(env, "google", { ...g, broken: true, error: j.error_description || j.error });
    return null;
  }
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000, rt: g.refresh_token };
  return cached.token;
}

async function gfetch(env, path, opt = {}) {
  const token = await accessToken(env);
  if (!token) throw Object.assign(new Error("Google Agenda não conectada"), { status: 401 });
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    ...opt,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opt.headers || {}) },
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || r.statusText), { status: r.status });
  return j;
}

/* ---------- puxar agendas para o app ---------- */
const safeId = (s) => s.replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 120);

/* ---------- agenda "Gatitos": tudo que entra nela convida a Raquel ---------- */
export async function ensureGatitosCal(env) {
  const g = await kvGet(env, "google");
  if (!g || g.broken) return null;
  if (g.gatitosCal) return g.gatitosCal;
  try {
    const cal = await gfetch(env, "/calendars", {
      method: "POST",
      body: JSON.stringify({ summary: "Gatitos", description: "Eventos do casal. Tudo que for criado aqui convida a Raquel automaticamente (Nosso Universo).", timeZone: TZ }),
    });
    await kvSet(env, "google", { ...g, gatitosCal: cal.id });
    return cal.id;
  } catch (err) {
    console.error("criar agenda Gatitos", err);
    return null;
  }
}

async function inviteSweep(env, calId, raquel) {
  if (!calId || !raquel) return 0;
  const q = new URLSearchParams({ timeMin: new Date(Date.now() - DAY_MS).toISOString(), singleEvents: "false", maxResults: "250", showDeleted: "false" });
  const j = await gfetch(env, `/calendars/${encodeURIComponent(calId)}/events?${q}`);
  let invited = 0;
  for (const e of j.items || []) {
    if (e.status === "cancelled" || e.recurringEventId) continue; // convida pela série, não por ocorrência
    const att = e.attendees || [];
    if (att.some((a) => (a.email || "").toLowerCase() === raquel)) continue;
    await gfetch(env, `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(e.id)}?sendUpdates=all`, {
      method: "PATCH",
      body: JSON.stringify({ attendees: [...att, { email: raquel }] }),
    });
    invited++;
  }
  return invited;
}

export async function pullCalendars(env, cfg) {
  const g = await kvGet(env, "google");
  if (!g || g.broken || !googleConfigured(env)) return { ok: false, reason: "not_connected" };
  const raquel = String(cfg.calRaquel || env.EMAIL_RAQUEL || "").split(",")[0].trim().toLowerCase();
  const gatitos = await ensureGatitosCal(env);
  let convites = 0;
  try { convites = await inviteSweep(env, gatitos, raquel); } catch (err) { console.error("convites Gatitos", err); }
  const cals = [["a", "primary"]];
  if (gatitos) cals.push(["g", gatitos]);
  if (raquel) cals.push(["b", raquel]);
  const timeMin = new Date(Date.now() - 7 * 864e5).toISOString();
  const timeMax = new Date(Date.now() + 120 * 864e5).toISOString();
  const status = {};
  const docs = [];
  for (const [who, cal] of cals) {
    try {
      let pageToken = "";
      let n = 0;
      do {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
        if (pageToken) q.set("pageToken", pageToken);
        const j = await gfetch(env, `/calendars/${encodeURIComponent(cal)}/events?${q}`);
        for (const e of j.items || []) {
          if (e.status === "cancelled") continue;
          if (e.extendedProperties?.shared?.nu) continue; // criado pelo próprio app: já está em "ev"
          const org = (e.organizer?.email || "").toLowerCase();
          if (who === "b" && (org === g.email || (gatitos && org === gatitos.toLowerCase()))) continue; // convite do Zé ou da agenda Gatitos: já aparece do lado dele
          if (who === "a" && raquel && org === raquel) continue; // convite da Raquel: já aparece do lado dela
          const me = (e.attendees || []).find((x) => x.self);
          if (me?.responseStatus === "declined") continue;
          const s = e.start || {};
          const en = e.end || {};
          let data, hora = "", fim = "", allDay = false;
          if (s.date) { data = s.date; allDay = true; }
          else { const p = brParts(new Date(s.dateTime)); data = p.date; hora = p.time; if (en.dateTime) fim = brParts(new Date(en.dateTime)).time; }
          docs.push({ id: safeId(`${who}-${e.id}`), data: { titulo: e.summary || "(sem título)", data, hora, fim, allDay, local: e.location || "", cal: who, link: e.htmlLink || "" } });
          n++;
        }
        pageToken = j.nextPageToken || "";
      } while (pageToken && n < 1500);
      status[who] = { ok: true, n };
    } catch (err) {
      status[who] = { ok: false, erro: err.status === 404 || err.status === 403 ? "agenda não compartilhada com o Zé" : String(err.message || err) };
    }
  }
  const now = Date.now();
  const stmts = [];
  for (const who of Object.keys(status)) if (status[who].ok) stmts.push(env.DB.prepare("DELETE FROM docs WHERE col = 'gcal' AND id LIKE ?1").bind(`${who}-%`));
  const ins = env.DB.prepare("INSERT OR REPLACE INTO docs (col, id, data, updated_at, updated_by) VALUES ('gcal', ?1, ?2, ?3, 'google')");
  for (const d of docs) if (status[d.data.cal]?.ok) stmts.push(ins.bind(d.id, JSON.stringify(d.data), now));
  if (stmts.length) await env.DB.batch(stmts);
  await kvSet(env, "google_sync", { at: now, status, convites, gatitos: !!gatitos });
  return { ok: true, status, convites };
}

/* ---------- espelhar eventos do app na agenda do Zé (e convidar a Raquel) ---------- */
const RRULE = { semanal: "RRULE:FREQ=WEEKLY", quinzenal: "RRULE:FREQ=WEEKLY;INTERVAL=2", mensal: "RRULE:FREQ=MONTHLY", anual: "RRULE:FREQ=YEARLY" };
export const MIRROR_FIELDS = ["titulo", "data", "hora", "local", "repete", "quem", "google", "nota"];

function eventBody(id, d, attendees) {
  const timed = /^\d\d:\d\d$/.test(d.hora || "");
  return {
    summary: d.titulo || "Evento",
    location: d.local || undefined,
    description: [d.nota, "Criado no Nosso Universo."].filter(Boolean).join("\n\n"),
    start: timed ? { dateTime: `${d.data}T${d.hora}:00`, timeZone: TZ } : { date: d.data },
    end: timed ? { dateTime: addMinutesLocal(d.data, d.hora, 60), timeZone: TZ } : { date: nextDay(d.data) },
    recurrence: RRULE[d.repete] ? [RRULE[d.repete]] : [],
    attendees,
    extendedProperties: { shared: { nu: id } },
    reminders: { useDefault: true },
  };
}

// Eventos "dos dois" vão para a agenda Gatitos (com convite para a Raquel); os só do Zé, para a agenda principal dele.
// Retorna { gid, gcalId } quando o vínculo com o Google mudou (criado, movido ou removido), senão null.
export async function mirrorEvent(env, id, d) {
  const g = await kvGet(env, "google");
  if (!g || g.broken || !googleConfigured(env) || !d?.data) return null;
  let gid = d.gid || "";
  const cur = d.gcalId || "primary";
  const skip = d.google === "nao" || d.quem === "b"; // eventos só da Raquel ficam na agenda dela
  if (skip) {
    if (gid) await deleteMirror(env, gid, cur);
    return gid ? { gid: "", gcalId: "" } : null;
  }
  const gatitos = d.quem === "ambos" ? await ensureGatitosCal(env) : null;
  const target = gatitos || "primary";
  const raquel = String(env.EMAIL_RAQUEL || "").split(",")[0].trim();
  const attendees = d.quem === "ambos" && raquel ? [{ email: raquel }] : [];
  const body = eventBody(id, d, attendees);
  if (gid && cur !== target) { await deleteMirror(env, gid, cur); gid = ""; }
  if (gid) {
    try {
      await gfetch(env, `/calendars/${encodeURIComponent(target)}/events/${encodeURIComponent(gid)}?sendUpdates=all`, { method: "PATCH", body: JSON.stringify(body) });
      return null;
    } catch (err) {
      if (err.status !== 404 && err.status !== 410) throw err;
    }
  }
  const j = await gfetch(env, `/calendars/${encodeURIComponent(target)}/events?sendUpdates=all`, { method: "POST", body: JSON.stringify(body) });
  return { gid: j.id, gcalId: target };
}

export async function deleteMirror(env, gid, calId = "primary") {
  if (!gid) return;
  await gfetch(env, `/calendars/${encodeURIComponent(calId || "primary")}/events/${encodeURIComponent(gid)}?sendUpdates=all`, { method: "DELETE" }).catch(() => {});
}

/* ---------- e-mail pelo Gmail do Zé ---------- */
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export async function sendMail(env, to, subject, html) {
  const g = await kvGet(env, "google");
  if (!g || g.broken || !(g.scope || "").includes("gmail.send") || !to.length) return false;
  const mime = [
    `To: ${to.join(", ")}`,
    `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64utf8(html),
  ].join("\r\n");
  const raw = btoa(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await gfetch(env, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
  return true;
}
