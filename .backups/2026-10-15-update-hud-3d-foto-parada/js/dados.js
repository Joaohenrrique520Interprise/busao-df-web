// Acesso ao backend, armazenamento local e formatação compartilhada.

/** HTML com escape automático dos valores interpolados. Use bruto() para HTML já seguro. */
const BRUTO = Symbol("bruto");
export const bruto = (s) => ({ [BRUTO]: String(s) });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function h(partes, ...valores) {
  return bruto(partes.reduce((acc, p, i) => {
    if (i === 0) return p;
    const v = valores[i - 1];
    const txt = Array.isArray(v) ? v.map((x) => x?.[BRUTO] ?? esc(x)).join("") : v?.[BRUTO] ?? esc(v);
    return acc + txt + p;
  }, ""));
}
export const html = (frag) => frag[BRUTO];

// ------------------------------------------------------------------ armazenamento local
// localStorage pode não existir (aba anônima, bloqueio): tudo funciona sem ele.
export const local = {
  ler(chave, padrao) {
    try { const v = localStorage.getItem("busao:" + chave); return v === null ? padrao : JSON.parse(v); }
    catch { return padrao; }
  },
  gravar(chave, valor) {
    try { localStorage.setItem("busao:" + chave, JSON.stringify(valor)); } catch { /* sem armazenamento */ }
  },
};

// ------------------------------------------------------------------ backend
export class ErroApi extends Error {}

/** Dentro do app Android (Capacitor) não há servidor: as rotas /api/* são atendidas pelo motor local. */
export const nativo = Boolean(window.Capacitor?.isNativePlatform?.());
let motor = null;

export async function pedir(caminho, params = {}) {
  if (nativo) {
    motor ??= import("./motor.js");
    try { return await (await motor).atender(caminho, params); }
    catch (e) { throw new ErroApi(navigator.onLine ? e.message : "Você está sem internet."); }
  }
  const url = new URL(caminho, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  let r;
  try {
    r = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    throw new ErroApi(navigator.onLine ? "Não consegui falar com o servidor do Busão DF." : "Você está sem internet.");
  }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi(typeof corpo.detail === "string" ? corpo.detail : "Algo deu errado. Tente de novo.");
  return corpo;
}

/**
 * Tempo real. Usa SSE e, se ele não entregar nada em 10 s (ou no túnel rápido da Cloudflare,
 * que não suporta SSE), passa a consultar /api/agora a cada intervalo. Devolve uma função para fechar.
 */
export function aoVivo(params, { dados, erro, estado, config }) {
  const consulta = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  let fechado = false, fonte = null, temporizador = null, vigia = null, intervaloMs = 15000;
  estado("conectando");

  function consultar() {
    return pedir("/api/agora", consulta).then((d) => {
      if (fechado) return;
      estado("ok");
      dados(d);
    }).catch(() => {
      if (fechado) return;
      if (navigator.onLine) erro("Sem resposta do DF no Ponto; tentando de novo."); else estado("offline");
    }).finally(() => { if (!fechado) temporizador = setTimeout(consultar, intervaloMs); });
  }
  function porConsulta() {
    fonte?.close();
    fonte = null;
    if (!fechado && !temporizador) consultar();
  }

  if (nativo || location.hostname.endsWith(".trycloudflare.com") || !("EventSource" in window)) porConsulta();
  else {
    const url = new URL("/api/ao-vivo", location.origin);
    for (const [k, v] of Object.entries(consulta)) url.searchParams.set(k, v);
    fonte = new EventSource(url);
    vigia = setTimeout(porConsulta, 10000);
    fonte.addEventListener("dados", (e) => { clearTimeout(vigia); estado("ok"); dados(JSON.parse(e.data)); });
    fonte.addEventListener("erro", (e) => erro(JSON.parse(e.data).detail));
    fonte.addEventListener("config", (e) => {
      const c = JSON.parse(e.data);
      intervaloMs = c.intervalo_s * 1000;
      config?.(c);
    });
    fonte.onerror = () => estado(navigator.onLine ? "conectando" : "offline");   // o EventSource reconecta sozinho
  }
  return () => { fechado = true; fonte?.close(); clearTimeout(temporizador); clearTimeout(vigia); };
}

// ------------------------------------------------------------------ relógio
// Corrige a diferença entre o relógio do aparelho e o do servidor.
let desvioMs = 0;
export const sincronizar = (isoServidor) => { desvioMs = Date.parse(isoServidor) - Date.now(); };
export const agoraMs = () => Date.now() + desvioMs;
export const segundosAte = (iso) => (Date.parse(iso) - agoraMs()) / 1000;

export function faltaCurta(iso) {
  const s = segundosAte(iso);
  if (s <= 30) return "agora";
  const min = Math.floor(s / 60);
  if (min < 60) return `${Math.max(min, 1)} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

export const horaCurta = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function distancia(m) {
  if (m == null) return "";
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}

export function atrasoTexto(seg) {
  const min = Math.round((seg || 0) / 60);
  if (min >= 2) return { classe: "atrasado", texto: `${min} min atrasado` };
  if (min <= -2) return { classe: "adiantado", texto: `${-min} min adiantado` };
  return { classe: "no_horario", texto: "no horário" };
}

// ------------------------------------------------------------------ selos de confiança
const ICONES = {
  gps: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/><circle class="onda" cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  gps_velho: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.6"/></svg>',
  tabela: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10.5" rx="2"/><path d="M2.5 6.5h11M6 3V1.8M10 3V1.8"/></svg>',
  fantasma: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3"/><circle cx="8" cy="11.6" r=".4" fill="currentColor"/></svg>',
};
export const CONFIANCA = {
  gps: { rotulo: "GPS ao vivo", explica: "Ônibus rastreado agora." },
  gps_velho: { rotulo: "GPS atrasado", explica: "A última posição tem mais de 2 minutos." },
  tabela: { rotulo: "Só tabela", explica: "Horário programado; o ônibus ainda não aparece no GPS." },
  fantasma: { rotulo: "Pode não passar", explica: "Já devia ter saído do terminal e não aparece no GPS." },
};
export const selo = (c) => h`<span class="selo selo-${c}" title="${CONFIANCA[c].explica}">${bruto(ICONES[c])}${CONFIANCA[c].rotulo}</span>`;

// Texto preto ou branco, o que tiver mais contraste com a cor da linha (a cor de texto da API às vezes não passa no WCAG AA).
function textoSobre(cor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(cor || "");
  if (!m) return "#fff";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#111" : "#fff";
}
export const chipLinha = (numero, cor, _corTextoApi, grande = false) =>
  h`<span class="chip-linha${grande ? " grande" : ""}" style="--cor:${cor};--cor-texto:${textoSobre(cor)}">${numero}</span>`;

// ------------------------------------------------------------------ polyline (formato Google, precisão 5)
export function decodificar(str) {
  const pontos = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const eixo of [0, 1]) {
      let b, deslocamento = 0, resultado = 0;
      do { b = str.charCodeAt(i++) - 63; resultado |= (b & 0x1f) << deslocamento; deslocamento += 5; } while (b >= 0x20);
      const d = resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
      if (eixo === 0) lat += d; else lon += d;
    }
    pontos.push([lon / 1e5, lat / 1e5]);
  }
  return pontos;
}

export function metros(a, b) {
  const r = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}
