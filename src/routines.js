// Rotinas automáticas da Neide (rodam pelo agendador da Cloudflare, no fuso de São Paulo):
// - todo dia 07:30: recado do dia (no app e, se ligado, por e-mail);
// - domingo 19:00: pauta do Conselho de Casa;
// - dia 1º 08:00: fechamento do mês anterior.
import Anthropic from "@anthropic-ai/sdk";
import { todayBR, sendMail } from "./google.js";

const DAY = 864e5;
const parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const isoD = (t) => new Date(t).toISOString().slice(0, 10);
const addD = (s, n) => isoD(parseD(s).getTime() + n * DAY);
const diffD = (a, b) => Math.round((parseD(a) - parseD(b)) / DAY);
const brl = (v) => (+v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const fmtDia = (s) => { const d = parseD(s); return `${DIAS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

export async function loadAll(env) {
  const { results } = await env.DB.prepare("SELECT col, id, data FROM docs WHERE col != 'brief'").all();
  const S = {};
  for (const r of results) (S[r.col] ??= []).push({ ...JSON.parse(r.data), id: r.id });
  return S;
}
const cfgOf = (S) => ({ a: "Zé", b: "Raquel", casal: "Gatitos", casamento: "2027-09-18", ...((S.config || []).find((c) => c.id === "casal") || {}) });

function occurs(e, day) {
  if (!e.data) return false;
  const r = e.repete || "nao";
  if (r === "nao") return e.data === day;
  if (day < e.data) return false;
  const d = diffD(day, e.data);
  if (r === "semanal") return d % 7 === 0;
  if (r === "quinzenal") return d % 14 === 0;
  if (r === "mensal") return e.data.slice(8) === day.slice(8);
  if (r === "anual") return e.data.slice(5) === day.slice(5);
  return false;
}

// Tudo que acontece em um dia, de todas as fontes do app.
function agendaDoDia(S, day) {
  const out = [];
  const m = day.slice(0, 7);
  const who = { a: "Zé", b: "Raquel", ambos: "os dois" };
  for (const e of S.ev || []) if (occurs(e, day)) out.push(`${e.hora ? e.hora + " " : ""}${e.titulo}${e.quem ? ` (${who[e.quem] || e.quem})` : ""}`);
  for (const e of S.gcal || []) if (e.data === day) out.push(`${e.hora ? e.hora + " " : ""}${e.titulo} (agenda ${e.cal === "b" ? "da Raquel" : "do Zé"})`);
  for (const b of S.bday || []) if (b.dia && b.mes && +b.dia === +day.slice(8) && +b.mes === +day.slice(5, 7)) out.push(b.tipo === "aniversario" ? `Aniversário de ${b.nome}` : b.nome);
  for (const b of S.bills || []) if (b.dia && +b.dia === +day.slice(8) && !(b.pagos || []).includes(m) && (!b.fim || b.fim >= m)) out.push(`Vence ${b.nome} (${brl(b.valor)})`);
  for (const t of S.tasks || []) if (t.tipo === "unica" && !t.feito && t.prazo === day) out.push(`Prazo: ${t.titulo}`);
  for (const w of S.wed || []) if (w.status !== "feito" && w.prazo === day) out.push(`Casório: ${w.titulo}`);
  return out;
}

export function snapshot(S, today = todayBR()) {
  const c = cfgOf(S);
  const m = today.slice(0, 7);
  const dueOf = (t) => (t.ultima ? addD(t.ultima, +t.freq || 7) : today);
  const rot = (S.tasks || []).filter((t) => t.tipo !== "unica");
  const atrasadas = rot.filter((t) => (+t.freq || 7) > 1 && dueOf(t) < today).map((t) => `${t.titulo} (${diffD(today, dueOf(t))}d)`);
  const deHoje = rot.filter((t) => (+t.freq || 7) > 1 && dueOf(t) === today).map((t) => t.titulo);
  const pendencias = (S.tasks || []).filter((t) => t.tipo === "unica" && !t.feito && t.prazo && t.prazo <= addD(today, 7)).map((t) => `${t.titulo} (prazo ${t.prazo})`);
  const contas = (S.bills || []).filter((b) => (!b.fim || b.fim >= m) && !(b.pagos || []).includes(m));
  const parcelas = [];
  for (const v of S.vend || []) for (const p of v.parcelas || []) if (p.mes === m && !p.pago) parcelas.push(`${v.nome} ${brl(p.valor)}`);
  const semana = [];
  for (let i = 0; i < 7; i++) { const d = addD(today, i); const it = agendaDoDia(S, d); if (it.length) semana.push(`${fmtDia(d)}: ${it.join("; ")}`); }
  const proxDatas = (S.bday || []).filter((b) => b.dia && b.mes).map((b) => {
    let d = `${today.slice(0, 4)}-${String(b.mes).padStart(2, "0")}-${String(b.dia).padStart(2, "0")}`;
    if (d < today) d = `${+today.slice(0, 4) + 1}${d.slice(4)}`;
    return { nome: b.nome, d, em: diffD(d, today) };
  }).filter((x) => x.em <= 21).sort((a, b) => a.em - b.em).map((x) => `${x.nome} em ${x.em} dias (${fmtDia(x.d)})`);
  const semCheckin = (S.goals || []).filter((g) => !(g.checkins || []).some((k) => k.mes === m)).map((g) => g.titulo);
  return {
    hoje: fmtDia(today),
    casal: `${c.a} e ${c.b}`,
    diasParaOCasamento: diffD(c.casamento, today),
    agendaHoje: agendaDoDia(S, today),
    proximos7dias: semana,
    tarefasAtrasadas: atrasadas,
    tarefasDeHoje: deHoje,
    pendenciasComPrazo: pendencias,
    contasDoMesAPagar: contas.map((b) => `${b.nome} ${brl(b.valor)}${b.dia ? ` dia ${b.dia}` : ""}`),
    totalContasAPagar: brl(contas.reduce((s, b) => s + (+b.valor || 0), 0)),
    parcelasCasamentoDoMes: parcelas,
    proximasDatasEspeciais: proxDatas,
    metasSemCheckinNoMes: semCheckin,
    filmesNaFila: (S.watch || []).filter((w) => w.status === "quero").length,
  };
}

async function activitySummary(env, sinceMs) {
  const { results } = await env.DB.prepare("SELECT who, acao, titulo FROM activity WHERE ts >= ?1 ORDER BY ts").bind(sinceMs).all();
  const por = { a: 0, b: 0 };
  for (const r of results) if (por[r.who] != null) por[r.who]++;
  return { totalDeAcoes: results.length, acoesDoZe: por.a, acoesDaRaquel: por.b, exemplos: results.slice(-15).map((r) => `${r.who === "a" ? "Zé" : "Raquel"} ${r.acao} ${r.titulo}`) };
}

const PEDIDOS = {
  dia: "Escreva o RECADO DO DIA: no máximo 8 linhas curtas. Comece com uma saudação aos Gatitos e o dia. Depois: o que tem hoje na agenda, o que da casa chegou a vez (diga só os 3 mais importantes), conta ou parcela que vence perto, e uma data especial se estiver chegando. Termine com uma frase leve ou provocação boa. Se o dia estiver tranquilo, diga isso.",
  semana: "Escreva a PAUTA DO CONSELHO DE CASA deste domingo: 4 blocos curtos com título (Agenda da semana, Casa, Dinheiro, Casamento). Em cada bloco, 1 a 3 itens objetivos. Inclua o placar da semana (quem marcou mais tarefas) com humor e 1 pergunta para os dois conversarem. Máximo 18 linhas.",
  mes: "Escreva o FECHAMENTO DO MÊS: o que funcionou, o que travou, contas e parcelas do casamento, placar do mês entre os dois e um lembrete para o check-in das metas. Termine com 1 meta pequena para o mês que começa. Máximo 16 linhas.",
};

async function writeWithNeide(env, tipo, dados) {
  const fallback = () => {
    const linhas = [`Oi, Gatitos! ${dados.hoje}.`];
    if (dados.agendaHoje?.length) linhas.push(`Hoje: ${dados.agendaHoje.join("; ")}.`);
    if (dados.tarefasAtrasadas?.length) linhas.push(`Na casa, chegou a vez de: ${dados.tarefasAtrasadas.slice(0, 3).join(", ")}.`);
    if (dados.parcelasCasamentoDoMes?.length) linhas.push(`Casório: parcelas do mês em aberto (${dados.parcelasCasamentoDoMes.length}).`);
    if (dados.proximasDatasEspeciais?.length) linhas.push(`Vem aí: ${dados.proximasDatasEspeciais[0]}.`);
    linhas.push(`Faltam ${dados.diasParaOCasamento} dias para o sim.`);
    return linhas.join("\n");
  };
  if (!env.ANTHROPIC_API_KEY) return fallback();
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const r = await client.beta.messages.create({
      model: env.NEIDE_MODEL || "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: "Você é a NEIDE, assistente virtual do casal Zé e Raquel, os Gatitos. Português do Brasil, tom carinhoso, prático e com humor leve. Texto puro, sem markdown, sem asteriscos; use quebras de linha. Use só os dados fornecidos, sem inventar compromissos.",
      messages: [{ role: "user", content: `${PEDIDOS[tipo]}\n\nDados (JSON):\n${JSON.stringify(dados)}` }],
    });
    if (r.stop_reason === "refusal") return fallback();
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return text || fallback();
  } catch (err) {
    console.error("neide brief", err);
    return fallback();
  }
}

const TITULOS = { dia: "Recado do dia", semana: "Pauta do Conselho de Casa", mes: "Fechamento do mês" };

export async function runRoutine(env, tipo, putDoc) {
  const S = await loadAll(env);
  const today = todayBR();
  const dados = snapshot(S, today);
  if (tipo === "semana") dados.ultimos7dias = await activitySummary(env, Date.now() - 7 * DAY);
  if (tipo === "mes") dados.ultimos30dias = await activitySummary(env, Date.now() - 30 * DAY);
  const texto = await writeWithNeide(env, tipo, dados);
  const doc = { tipo, titulo: TITULOS[tipo], texto, para: today, gerado: new Date().toISOString() };
  await putDoc(env, "brief", tipo, doc, "neide");
  if (tipo !== "dia") await putDoc(env, "brief", `${tipo}-${today}`, doc, "neide");

  const cfg = cfgOf(S);
  if (cfg.emailRecados !== "nao") {
    const to = [env.EMAIL_ZE, env.EMAIL_RAQUEL].map((e) => String(e || "").split(",")[0].trim()).filter(Boolean);
    const app = env.APP_URL || "";
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#10202a;max-width:560px">
      <p style="font:700 12px Arial;letter-spacing:.2em;color:#0d6476;text-transform:uppercase;margin:0 0 8px">N.E.I.D.E · ${TITULOS[tipo]}</p>
      ${texto.split(/\n+/).map((l) => `<p style="margin:0 0 8px">${l.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</p>`).join("")}
      ${app ? `<p style="margin:16px 0 0"><a href="${app}" style="color:#0d6476;font-weight:700">Abrir o Nosso Universo</a></p>` : ""}
    </div>`;
    try { await sendMail(env, to, `Neide · ${TITULOS[tipo]} · ${dados.hoje}`, html); } catch (err) { console.error("email", err); }
  }
  return doc;
}
