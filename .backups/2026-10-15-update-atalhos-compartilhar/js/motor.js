// Motor local: a mesma lógica do servidor Python (busao/api.py, busao/previsao.py, busao/web/app.py),
// rodando dentro do app Android. No app nativo as chamadas HTTP saem pela rede do Android
// (CapacitorHttp), sem o bloqueio de CORS que impede um site de falar direto com a API.
// Devolve exatamente os mesmos formatos JSON das rotas /api/* do servidor.

const API = "https://mobilibus.com/api";
const OTP = "https://otp.mobilibus.com/FY7J-lwk85QGbn/otp/routers/default";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const WIKIMEDIA = "https://commons.wikimedia.org/w/api.php";
const PROJETO = "3c189";
const CAIXA_DF = "-48.30,-15.45,-47.30,-16.06";
const FUSO_MS = -3 * 3600 * 1000;           // Brasília, sem horário de verão
const DIA_MS = 86400000;
const GPS_VELHO_S = 120;
const RAIO_PARADAS_M = 500, RAIO_MAX_M = 1200, RAIO_DESTINO_M = 700, RAIO_VEICULOS_M = 6000;
const MAX_VIAGENS_AO_VIVO = 30, DESVIO_MAX_M = 60, SALTO_MAX_M = 3000, ANDAR_M_POR_MIN = 75;
export const INTERVALO_S = 15;

export class ErroUsuario extends Error {}

const verdadeiro = (valor) => valor === true || valor === 1 || ["1", "true", "sim", "yes", "y"].includes(String(valor).toLowerCase());

/** Normaliza os campos de conforto que a Mobilibus expõe em viagens e partidas. */
export function metadadosConforto(...fontes) {
  const objetos = fontes.filter(Boolean);
  const texto = objetos.flatMap((o) => [o.features, o.feature, o.equipment, o.equipments, o.amenities, o.description, o.desc])
    .flat().filter(Boolean).join(" ").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const acessivel = objetos.some((o) => [o.wa, o.wheelchairAccessible, o.wheelchair_accessible, o.accessible,
    o.accessibility, o.elevator, o.hasElevator, o.ramp, o.hasRamp].some(verdadeiro))
    || /cadeir|acess|elevador|rampa|wheelchair/.test(texto);
  const arCondicionado = objetos.some((o) => [o.ac, o.airConditioned, o.air_conditioned, o.airConditioning,
    o.hasAirConditioning, o.arCondicionado, o.climatizado].some(verdadeiro))
    || /ar[- ]?condicionado|climatiz|air[- ]?condition/.test(texto);
  return { acessivel, ar_condicionado: arCondicionado };
}

const ESTACOES_METRO = [
  "central", "galeria", "102 sul", "108 sul", "112 sul", "114 sul", "asa sul", "shopping",
  "feira", "guara", "arniqueiras", "aguas claras", "concessionarias", "praca do relogio",
  "taguatinga sul", "furnas", "samambaia sul", "terminal samambaia", "ceilandia sul", "guariroba",
  "ceilandia centro", "ceilandia norte", "terminal ceilandia",
];
const ESTACOES_BRT = [
  "brt", "terminal gama", "terminal santa maria", "terminal park way", "park way", "catetinho",
  "vargem bonita", "granja do ipe", "santos dumont", "periquito", "flor do cerrado",
  "terminal ceilandia", "terminal sol nascente", "terminal p sul", "terminal p norte",
];

/** Identifica estações e terminais onde a rota permite integração estrutural. */
export function tipoIntegracao(nome = "") {
  const n = normalizar(nome);
  if (/\bmetro\b/.test(n) || ((n.includes("estacao") || n.includes("terminal")) && ESTACOES_METRO.some((x) => n.includes(x)))) {
    return { tipo: "metro", rotulo: "Metrô-DF" };
  }
  if (ESTACOES_BRT.some((x) => n.includes(x)) && (n.includes("estacao") || n.includes("terminal") || n.includes("brt"))) {
    return { tipo: "brt", rotulo: "BRT" };
  }
  return null;
}

// ================================================================ HTTP com cache
const cache = new Map();          // url -> {expira, valor}
let ativos = 0;
const fila = [];
const limite = async (fn) => {   // no máximo 6 consultas ao mesmo tempo
  if (ativos >= 6) await new Promise((ok) => fila.push(ok));
  ativos++;
  try { return await fn(); } finally { ativos--; fila.shift()?.(); }
};

/** Monta a URL com espaço como %20 (a busca de paradas não entende "+"). */
export function montarUrl(base, params) {
  const qs = Object.keys(params).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
  return `${base}?${qs}`;
}

export let buscarHttp = (url, opcoes) => fetch(url, opcoes);   // trocável nos testes
export const usarHttp = (fn) => { buscarHttp = fn; };

async function obter(base, params, ttlS, cabecalhos = {}) {
  const url = montarUrl(base, params);
  const achado = cache.get(url);
  if (achado && achado.expira > Date.now()) return achado.valor;
  const valor = await limite(async () => {
    for (let tentativa = 1; ; tentativa++) {
      try {
        const controle = new AbortController();
        const prazo = setTimeout(() => controle.abort(), 12000);
        const r = await buscarHttp(url, { headers: { Accept: "application/json", ...cabecalhos }, signal: controle.signal });
        clearTimeout(prazo);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (tentativa >= 2) throw e;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
  });
  cache.set(url, { expira: Date.now() + ttlS * 1000, valor });
  if (cache.size > 3000) for (const [k, v] of cache) if (v.expira <= Date.now()) cache.delete(k);
  return valor;
}

// ================================================================ API Mobilibus
const soDigitos = (t) => String(t).replace(/\D/g, "").replace(/^0+/, "");
export const normalizar = (t) => String(t).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

async function linhas() {
  const lista = await obter(`${API}/routes`, { project_hash: PROJETO }, 12 * 3600);
  for (const l of lista) l.shortName = l.shortName || l.longName || "";   // Metrô vem sem número
  return lista;
}
async function operadoras() {
  const lista = await obter(`${API}/agencies`, { project_hash: PROJETO }, 24 * 3600);
  return Object.fromEntries(lista.map((a) => [a.agencyId, a.name]));
}
async function buscarLinha(texto) {
  const t = String(texto).trim().replace(",", ".");
  const todas = await linhas();
  const exatas = todas.filter((l) => l.shortName === t);
  if (exatas.length) return exatas;
  const chave = soDigitos(t);
  return chave ? todas.filter((l) => soDigitos(l.shortName) === chave) : [];
}
const horarios = (id) => obter(`${API}/timetable`, { v: 2, route_hash: id }, 6 * 3600);
const viagem = (id) => obter(`${API}/trip-details`, { v: 2, trip_hash: id }, 24 * 3600);
const veiculos = (id) => obter(`${API}/vehicles`, { trip_hash: id }, 15);

/** Uma consulta por parada: com várias de uma vez a API devolve cada viagem em só uma delas. */
export async function partidas(stopIds) {
  const unicas = [...new Set(stopIds)].sort();
  const respostas = await Promise.all(unicas.map((s) => obter(`${API}/departures`, { v: 2, stop_hash: s }, 15)));
  const viagens = respostas.flatMap((r) => r.trips ?? []);
  for (const t of viagens) t.shortName = t.shortName || t.longName || "Metrô";
  return viagens;
}
export const buscarParadas = (termo) => obter(`${API}/search-stops`, { project_hash: PROJETO, search: termo }, 24 * 3600);

/** Procura foto pública próxima e usa satélite estático quando ela não existe. */
export async function imagemParada(lat, lon) {
  const latitude = Number(lat), longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new ErroUsuario("Coordenadas da parada inválidas.");
  try {
    const dados = await obter(WIKIMEDIA, {
      action: "query", format: "json", origin: "*", generator: "geosearch", ggsnamespace: 6,
      ggsprimary: "all", ggsradius: 350, ggslimit: 8, ggscoord: `${latitude}|${longitude}`,
      prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: 960,
    }, 24 * 3600);
    const paginas = Object.values(dados.query?.pages ?? {}).filter((p) => p.imageinfo?.[0]?.thumburl);
    const foto = paginas.find((p) => !/map|logo|flag|icon|symbol|seal/i.test(p.title)) ?? paginas[0];
    if (foto) {
      const info = foto.imageinfo[0], meta = info.extmetadata ?? {};
      return { disponivel: true, tipo: "foto", url: info.thumburl, link: info.descriptionurl,
        credito: meta.Artist?.value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Wikimedia Commons",
        licenca: meta.LicenseShortName?.value || "Wikimedia Commons" };
    }
  } catch { /* segue para o fallback sem quebrar o painel */ }

  const deltaLon = 0.00145 / Math.max(Math.cos(latitude * Math.PI / 180), 0.2), deltaLat = 0.00145;
  const bbox = [longitude - deltaLon, latitude - deltaLat, longitude + deltaLon, latitude + deltaLat].join(",");
  return { disponivel: true, tipo: "satelite",
    url: montarUrl("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export", {
      bbox, bboxSR: 4326, imageSR: 4326, size: "960,540", format: "jpg", f: "image",
    }), link: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=19/${latitude}/${longitude}`,
    credito: "Imagem de satélite Esri World Imagery", licenca: "Contexto visual" };
}

const idsParada = new Map();
/** O planejador (OTP) usa outros IDs; casa a parada pelo nome + coordenada. */
async function idParada(nome, lat, lon) {
  const chave = `${nome}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
  if (!idsParada.has(chave)) {
    const perto = (await buscarParadas(nome)).map((c) => [distancia(lat, lon, c.lat, c.lng), c.stopId])
      .filter(([d]) => d <= 30).sort((a, b) => a[0] - b[0]);
    idsParada.set(chave, perto[0]?.[1] ?? null);
  }
  return idsParada.get(chave);
}
async function paradasProximas(lat, lon, raio, maximo = 6) {
  const brutas = (await obter(`${OTP}/index/stops`, { lat: lat.toFixed(6), lon: lon.toFixed(6), radius: raio }, 3600))
    .sort((a, b) => a.dist - b.dist).slice(0, maximo);
  const ids = await Promise.all(brutas.map((p) => idParada(p.name, p.lat, p.lon)));
  return brutas.map((p, i) => ids[i] && { stopId: ids[i], nome: p.name, lat: p.lat, lon: p.lon, dist: p.dist }).filter(Boolean);
}
async function planejar(origem, destino) {
  const d = await obter(`${OTP}/plan`, { fromPlace: `${origem[0]},${origem[1]}`, toPlace: `${destino[0]},${destino[1]}`,
    mode: "TRANSIT,WALK", numItineraries: 3, locale: "pt_BR" }, 60);
  return d.plan?.itineraries ?? [];
}

// ================================================================ geo
export function distancia(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
function lerCoordenada(texto) {
  const m = /^\s*(-?\d{1,2}[.,]\d+)\s*[,; ]\s*(-?\d{1,3}[.,]\d+)\s*$/.exec(texto);
  return m ? [parseFloat(m[1].replace(",", ".")), parseFloat(m[2].replace(",", "."))] : null;
}
const enderecos = new Map();
async function geocodificar(texto) {
  const chave = texto.trim().toLowerCase();
  if (!enderecos.has(chave)) {
    const achados = await obter(NOMINATIM, { q: `${texto}, Distrito Federal, Brasil`, format: "jsonv2", limit: 1,
      countrycodes: "br", viewbox: CAIXA_DF, bounded: 1, "accept-language": "pt-BR" }, 24 * 3600,
    { "User-Agent": "busao-df-app/1.0 (app pessoal de horarios de onibus)" });
    const a = achados[0];
    enderecos.set(chave, a ? [parseFloat(a.lat), parseFloat(a.lon), a.display_name.split(", ").slice(0, 3).join(", ")] : null);
  }
  return enderecos.get(chave);
}

// ================================================================ tempo (sempre no fuso de Brasília)
const meiaNoite = (refMs) => Math.floor((refMs + FUSO_MS) / DIA_MS) * DIA_MS - FUSO_MS;
export function hora(hhmm, refMs, diaSeguinte = false) {
  const [h = 0, m = 0, s = 0] = hhmm.split(":").map(Number);
  return meiaNoite(refMs) + ((h * 60 + m) * 60 + s) * 1000 + (diaSeguinte ? DIA_MS : 0);
}
export const faltam = (ms, refMs) => Math.floor((ms - refMs) / 60000);
export const isoBrasilia = (ms) => new Date(ms + FUSO_MS).toISOString().slice(0, 19) + "-03:00";
const dataBrasilia = (ms) => new Date(ms + FUSO_MS).toISOString().slice(0, 10);

export function proximas(lista, refMs) {
  return lista.map((p) => [hora(p.time, refMs, p.nextDay), p]).filter(([ms]) => ms >= refMs - 60000).sort((a, b) => a[0] - b[0]);
}

/** Quanto dá para confiar numa previsão: gps | gps_velho | tabela | fantasma. */
export function confianca(p, refMs) {
  if (p.vehicleId) return (p.positionAge || 0) <= GPS_VELHO_S ? "gps" : "gps_velho";
  // O fim do tripFeedId traz a saída programada do terminal (P132000 = 13:20:00):
  // se já passou e nenhum ônibus foi rastreado, a viagem pode não estar acontecendo.
  const m = /P(\d\d)(\d\d)(\d\d)$/.exec(p.tripFeedId || "");
  if (m && !p.nextDay) {
    const atraso = refMs - hora(`${m[1]}:${m[2]}:${m[3]}`, refMs);
    if (atraso > 3 * 60000 && atraso < 4 * 3600000) return "fantasma";
  }
  return "tabela";
}
const idadeGps = (v, refMs) => (v.positionTime ? (refMs - hora(v.positionTime, refMs)) / 1000 : 0);

function saidasHoje(tabela, seq, refMs) {
  const hoje = dataBrasilia(refMs), dia = new Date(refMs + FUSO_MS).getUTCDay();   // domingo = 0, igual à API
  const excecoes = Object.fromEntries((tabela.exceptions ?? []).filter((e) => e.date === hoje).map((e) => [e.serviceId, e.type]));
  const saidas = [];
  for (const direcao of tabela.directions ?? []) {
    for (const servico of direcao.services ?? []) {
      let ativo = servico.days[dia] && (servico.start ?? hoje) <= hoje && hoje <= (servico.end ?? hoje);
      if (servico.serviceId in excecoes) ativo = excecoes[servico.serviceId] > 0;
      if (!ativo) continue;
      for (const d of servico.departures) if (d.seq === seq) { const ms = hora(d.dep, refMs); if (ms >= refMs) saidas.push(ms); }
    }
  }
  return saidas.sort((a, b) => a - b);
}

export function paradaMaisProxima(paradas, lat, lon, raio = RAIO_MAX_M) {
  let melhor = null;
  for (const p of paradas) {
    const d = distancia(lat, lon, p.lat, p.lng);
    if (!melhor || d < melhor[0]) melhor = [d, p];
  }
  return melhor && melhor[0] <= raio ? melhor : null;
}
async function paradasPerto(lat, lon, maximo = 6) {
  for (const raio of [RAIO_PARADAS_M, RAIO_MAX_M]) {
    const lista = await paradasProximas(lat, lon, raio, maximo);
    if (lista.length) return lista;
  }
  throw new ErroUsuario(`Nenhuma parada de ônibus a menos de ${RAIO_MAX_M} m desse ponto.`);
}

// ================================================================ traçado (GPS sobre a rua)
export function decodificarPolyline(texto) {
  const pontos = [];
  let i = 0, lat = 0, lon = 0;
  while (i < texto.length) {
    for (const eixo of [0, 1]) {
      let b, deslocamento = 0, resultado = 0;
      do { b = texto.charCodeAt(i++) - 63; resultado |= (b & 0x1f) << deslocamento; deslocamento += 5; } while (b >= 0x20);
      const d = resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
      if (eixo === 0) lat += d; else lon += d;
    }
    pontos.push([lat / 1e5, lon / 1e5]);
  }
  return pontos;
}

export class Tracado {
  constructor(pontos) {
    this.pontos = pontos;
    this.lat0 = pontos.length ? (pontos[0][0] * Math.PI) / 180 : 0;
    this.xy = pontos.map(([la, lo]) => this.plano(la, lo));
    this.acumulado = [0];
    for (let i = 1; i < this.xy.length; i++) this.acumulado.push(this.acumulado[i - 1] + Math.hypot(this.xy[i][0] - this.xy[i - 1][0], this.xy[i][1] - this.xy[i - 1][1]));
  }
  plano(lat, lon) { return [((lon * Math.PI) / 180) * Math.cos(this.lat0) * 6371000, ((lat * Math.PI) / 180) * 6371000]; }

  /** [lat, lon, metros desde o início, rumo, desvio] do ponto do traçado mais perto. */
  encaixar(lat, lon) {
    if (this.pontos.length < 2) return null;
    const [px, py] = this.plano(lat, lon);
    let melhor = null;
    for (let i = 0; i < this.xy.length - 1; i++) {
      const [ax, ay] = this.xy[i], [bx, by] = this.xy[i + 1], dx = bx - ax, dy = by - ay, c2 = dx * dx + dy * dy;
      const t = c2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / c2));
      const desvio = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (!melhor || desvio < melhor[0]) melhor = [desvio, i, t];
    }
    const [desvio, i, t] = melhor;
    const [la, oa] = this.pontos[i], [lb, ob] = this.pontos[i + 1], [ax, ay] = this.xy[i], [bx, by] = this.xy[i + 1];
    const rumo = ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
    return [la + t * (lb - la), oa + t * (ob - oa), this.acumulado[i] + t * (this.acumulado[i + 1] - this.acumulado[i]), rumo, desvio];
  }
  pontoEm(d) {
    const total = this.acumulado[this.acumulado.length - 1];
    d = Math.max(0, Math.min(d, total));
    let i = 0;
    while (i < this.acumulado.length - 2 && this.acumulado[i + 1] <= d) i++;
    const seg = this.acumulado[i + 1] - this.acumulado[i], t = seg ? (d - this.acumulado[i]) / seg : 0;
    const [la, oa] = this.pontos[i], [lb, ob] = this.pontos[i + 1];
    return [la + t * (lb - la), oa + t * (ob - oa)];
  }
  /** Caminho pela rua entre duas distâncias ao longo do traçado. */
  trecho(de, ate) {
    const meio = this.pontos.filter((_, k) => this.acumulado[k] > de && this.acumulado[k] < ate);
    return [this.pontoEm(de), ...meio, this.pontoEm(ate)];
  }
}

const tracados = new Map();
async function tracado(trip) {
  if (!tracados.has(trip)) {
    try { tracados.set(trip, new Tracado(decodificarPolyline((await viagem(trip)).shape || ""))); }
    catch { return null; }                           // sem traçado: o ônibus fica no GPS cru
  }
  return tracados.get(trip);
}
const historico = new Map();     // id -> últimas 2 leituras distintas [hora, trip, metros, [lon, lat]]
function encaixar(v, trip, tr) {
  let lat = v.lat, lon = v.lng, rumo = v.heading || 0;
  const e = tr?.encaixar(lat, lon);
  if (!e || e[4] > DESVIO_MAX_M) return [lat, lon, rumo, [[lon, lat]]];
  let dist;
  [lat, lon, dist, rumo] = e;
  const id = String(v.vehicleId), horaGps = v.positionTime || "";
  const leituras = historico.get(id) ?? [];
  if (!leituras.length || leituras[leituras.length - 1][0] !== horaGps) {
    leituras.push([horaGps, trip, dist, [lon, lat]]);
    historico.set(id, leituras.slice(-2));
  }
  const l = historico.get(id);
  let trilha = [[lon, lat]];
  if (l.length === 2 && l[0][1] === trip && dist - l[0][2] > 0 && dist - l[0][2] < SALTO_MAX_M) {
    trilha = tr.trecho(l[0][2], dist).map(([a, o]) => [o, a]);
  }
  return [lat, lon, rumo, trilha];
}

// ================================================================ montagem das respostas (como em web/app.py)
function passagem(ms, p, refMs, paradaSeq = null, fonte = null) {
  const vivo = p.vehicleId;
  const conforto = metadadosConforto(fonte, p);
  const paradasRestantes = vivo && Number.isFinite(Number(paradaSeq)) && Number.isFinite(Number(p.stopSequence))
    ? Math.max(0, Number(paradaSeq) - Number(p.stopSequence)) : null;
  return { hora: isoBrasilia(ms), minutos: Math.max(faltam(ms, refMs), 0), confianca: confianca(p, refMs),
    veiculo: vivo || null, gps_idade_s: vivo ? (p.positionAge ?? null) : null,
    paradas_restantes: paradasRestantes, ...conforto };
}
const linhaJson = (l, ops) => ({ id: l.routeId, numero: l.shortName, nome: l.longName, cor: l.color || "#175898",
  cor_texto: l.textColor || "#FFFFFF", operadora: ops[l.agencyId] ?? "", preco: l.price ?? null, ...metadadosConforto(l) });
const paradaViagem = (s, dist = null) => ({ id: s.stopId, nome: s.name, lat: s.lat, lon: s.lng, dist_m: dist,
  integracao: tipoIntegracao(s.name) });
const paradaProximaJson = (p) => ({ id: p.stopId, nome: p.nome, lat: p.lat, lon: p.lon, dist_m: p.dist,
  integracao: tipoIntegracao(p.nome) });
const meta = (t) => ({ linha: t.shortName, cor: t.color || "#175898", route_id: t.routeId, trip_id: t.tripId,
  destino: t.headsign || "", ...metadadosConforto(t) });
const chegada = (t, prox, refMs) => ({ ...meta(t), passagens: prox.map(([ms, d]) => passagem(ms, d, refMs, t.stopSequence, t)) });
const andarMin = (d) => Math.max(1, Math.round((d * 1.3) / ANDAR_M_POR_MIN));

function statusVeiculo(v, idade) {
  if (idade > GPS_VELHO_S) return "gps_velho";
  const atraso = v.delay || 0;
  return atraso >= 180 ? "atrasado" : atraso <= -120 ? "adiantado" : "no_horario";
}
async function veiculosDe(viagens, refMs) {
  const ids = Object.keys(viagens).slice(0, MAX_VIAGENS_AO_VIVO);
  const [respostas, trs] = await Promise.all([
    Promise.allSettled(ids.map((t) => veiculos(t))), Promise.all(ids.map((t) => tracado(t)))]);
  const saida = {};
  ids.forEach((t, i) => {
    if (respostas[i].status !== "fulfilled") return;
    saida[t] = respostas[i].value.filter((v) => v.lat != null).map((v) => {
      const idade = idadeGps(v, refMs);
      const [lat, lon, rumo, trilha] = encaixar(v, t, trs[i]);
      return { id: String(v.vehicleId), lat, lon, rumo, trilha, atraso_s: Math.trunc(v.delay || 0),
        gps_idade_s: Math.trunc(Math.max(idade, 0)), status: statusVeiculo(v, idade), seq: v.seq || 0,
        ...viagens[t], ...metadadosConforto(viagens[t], v) };
    });
  });
  return saida;
}
async function linhaPorId(routeId) {
  const l = (await linhas()).find((x) => x.routeId === routeId);
  if (!l) throw new ErroUsuario("Linha não encontrada.");
  return l;
}

async function paradasComChegadas(lat, lon, refMs, maximo = 8) {
  let paradas;
  try { paradas = await paradasPerto(lat, lon, maximo); } catch (e) { if (e instanceof ErroUsuario) return [[], []]; throw e; }
  const todas = await partidas(paradas.map((p) => p.stopId));
  const saida = paradas.map((p) => {
    const itens = todas.filter((t) => t.stopId === p.stopId).map((t) => [t, proximas(t.departures, refMs).slice(0, 3)])
      .filter(([, prox]) => prox.length).map(([t, prox]) => chegada(t, prox, refMs))
      .sort((a, b) => a.passagens[0].hora.localeCompare(b.passagens[0].hora));
    return { parada: paradaProximaJson(p), chegadas: itens.slice(0, 15) };
  });
  return [saida, todas];
}

async function minhaParada(routeId, lat, lon, refMs, escolhida = null) {
  const tabela = await horarios(routeId);
  const sentidos = [...(tabela.timetable.trips ?? [])].sort((a, b) => a.seq - b.seq);
  const [detalhes, linha] = await Promise.all([Promise.all(sentidos.map((s) => viagem(s.tripId))), linhaPorId(routeId)]);
  const metas = Object.fromEntries(sentidos.map((s) => [s.tripId, { linha: linha.shortName, cor: linha.color || "#175898",
    route_id: routeId, trip_id: s.tripId, destino: s.headsign || "" }]));
  const frotas = await veiculosDe(metas, refMs);
  const minhas = {};
  sentidos.forEach((s, i) => {
    const manual = escolhida ? detalhes[i].stops.find((p) => p.stopId === escolhida) : null;
    if (manual) { minhas[s.tripId] = [lat != null ? distancia(lat, lon, manual.lat, manual.lng) : null, manual]; return; }
    const perto = lat != null ? paradaMaisProxima(detalhes[i].stops, lat, lon) : null;
    if (perto) minhas[s.tripId] = perto;
  });
  const chegadas = await partidas(Object.values(minhas).map(([, p]) => p.stopId));
  const saida = [];
  for (const s of sentidos) {
    if (!minhas[s.tripId]) continue;
    const [dist, parada] = minhas[s.tripId];
    const prox = chegadas.filter((t) => t.tripId === s.tripId && t.stopId === parada.stopId)
      .flatMap((t) => proximas(t.departures, refMs).map(([ms, p]) => [ms, p, t.stopSequence, t]))
      .sort((a, b) => a[0] - b[0]).slice(0, 3);
    const passagens = prox.map(([ms, p, paradaSeq, fonte]) => passagem(ms, p, refMs, paradaSeq, fonte));
    const primeiro = passagens.find((p) => p.confianca === "gps" || p.confianca === "gps_velho")?.veiculo ?? null;
    const frota = frotas[s.tripId] ?? [];
    const veiculo = frota.find((v) => v.id === primeiro) ?? null;
    const atraso = veiculo?.atraso_s ?? null;
    for (const p of passagens) {
      const v = frota.find((item) => item.id === p.veiculo);
      p.distancia_onibus_m = v ? Math.round(distancia(v.lat, v.lon, parada.lat, parada.lng)) : null;
      if (v) Object.assign(p, metadadosConforto(p, v));
    }
    saida.push({ trip_id: s.tripId, destino: s.headsign || "", parada: paradaViagem(parada, dist), escolhida: parada.stopId === escolhida,
      andar_min: dist != null ? andarMin(dist) : null, passagens, veiculo_proximo: primeiro, atraso_s: atraso });
  }
  return [saida, Object.values(frotas).flat()];
}

async function instantaneo(lat, lon, routeId, parada) {
  const refMs = Date.now();
  let paradas = [], chegadas = [], minha = [], vs = [];
  if (lat != null && lon != null) {
    [paradas, chegadas] = await paradasComChegadas(lat, lon, refMs);
    // Só consulta GPS das viagens que têm ônibus rastreado chegando nas paradas perto.
    const vivas = Object.fromEntries(chegadas.filter((t) => t.departures.some((d) => d.vehicleId)).map((t) => [t.tripId, meta(t)]));
    for (const lista of Object.values(await veiculosDe(vivas, refMs))) vs.push(...lista.filter((v) => distancia(lat, lon, v.lat, v.lon) <= RAIO_VEICULOS_M));
  }
  if (routeId) {
    const [m, daLinha] = await minhaParada(routeId, lat, lon, refMs, parada);
    minha = m;
    const ja = new Set(vs.map((v) => v.id));
    vs.push(...daLinha.filter((v) => !ja.has(v.id)));
  }
  return { ts: isoBrasilia(refMs), veiculos: vs, paradas, minha };
}

async function linhasDiretas(origem, destino, refMs) {
  const paradas = Object.fromEntries((await paradasPerto(origem[0], origem[1])).map((p) => [p.stopId, p]));
  const chegadas = await partidas(Object.keys(paradas));
  const viagens = [...new Set(chegadas.map((t) => t.tripId))];
  const detalhes = Object.fromEntries(await Promise.all(viagens.map(async (v) => [v, await viagem(v)])));
  const melhores = {};
  for (const t of chegadas) {
    const prox = proximas(t.departures, refMs);
    const seq = detalhes[t.tripId].stops, i = seq.findIndex((s) => s.stopId === t.stopId);
    if (!prox.length || i < 0) continue;
    const adiante = seq.slice(i + 1).map((s) => [distancia(destino[0], destino[1], s.lat, s.lng), s]);
    if (!adiante.length) continue;
    const [andar, desce] = adiante.reduce((a, b) => (b[0] < a[0] ? b : a));
    if (andar > RAIO_DESTINO_M) continue;
    const opcao = { trip: t, prox, parada: paradas[t.stopId], desce, andar };
    if (!melhores[t.tripId] || opcao.parada.dist < melhores[t.tripId].parada.dist) melhores[t.tripId] = opcao;
  }
  return Object.values(melhores).sort((a, b) => a.prox[0][0] - b.prox[0][0]);
}

const horaCurtaBrasilia = (ms) => new Date(ms + FUSO_MS).toISOString().slice(11, 16);

// ================================================================ rotas (mesmos caminhos do servidor)
const ROTAS = [
  [/^\/api\/linhas$/, async (_, q) => {
    let achadas = await buscarLinha(q.q);
    if (!achadas.length) {
      const termo = normalizar(q.q);
      achadas = (await linhas()).filter((l) => normalizar(l.longName).includes(termo) || normalizar(l.shortName).includes(termo));
    }
    const ops = await operadoras();
    return achadas.sort((a, b) => a.shortName.localeCompare(b.shortName)).slice(0, 25).map((l) => linhaJson(l, ops));
  }],
  [/^\/api\/linhas\/([^/]+)\/minha-parada$/, async ([, id], q) => {
    if ((q.lat == null || q.lon == null) && !q.parada) throw new ErroUsuario("Informe a localização ou a parada.");
    return (await minhaParada(id, num(q.lat), num(q.lon), Date.now(), q.parada ?? null))[0];
  }],
  [/^\/api\/linhas\/([^/]+)$/, async ([, id]) => {
    const refMs = Date.now();
    const [linha, tabela, ops] = await Promise.all([linhaPorId(id), horarios(id), operadoras()]);
    const sentidos = [...(tabela.timetable.trips ?? [])].sort((a, b) => a.seq - b.seq);
    const detalhes = await Promise.all(sentidos.map((s) => viagem(s.tripId)));
    return { linha: linhaJson(linha, ops), sentidos: sentidos.map((s, i) => ({
      trip_id: s.tripId, destino: s.headsign || s.tripDesc || "", tracado: detalhes[i].shape || "",
      paradas: detalhes[i].stops.map((p) => paradaViagem(p)),
      saidas_terminal: saidasHoje(tabela.timetable, s.seq, refMs).slice(0, 6).map(horaCurtaBrasilia) })) };
  }],
  [/^\/api\/paradas\/proximas$/, async (_, q) => (await paradasComChegadas(num(q.lat), num(q.lon), Date.now(), 6))[0]],
  [/^\/api\/paradas\/area$/, async (_, q) => {
    const raio = Math.min(3000, Math.max(100, Math.round(num(q.raio) || 1500)));
    const brutas = await obter(`${OTP}/index/stops`, { lat: num(q.lat).toFixed(4), lon: num(q.lon).toFixed(4), radius: raio }, 3600);
    return brutas.map((p) => ({ id: "", nome: p.name, lat: p.lat, lon: p.lon, dist_m: null }));
  }],
  [/^\/api\/paradas\/identificar$/, async (_, q) => {
    const id = await idParada(q.nome, num(q.lat), num(q.lon));
    if (!id) throw new ErroUsuario("Esta parada não tem previsão no DF no Ponto.");
    return { id, nome: q.nome, lat: num(q.lat), lon: num(q.lon), dist_m: null };
  }],
  [/^\/api\/paradas\/imagem$/, async (_, q) => imagemParada(num(q.lat), num(q.lon))],
  [/^\/api\/paradas\/([^/]+)\/chegadas$/, async ([, id]) => {
    const refMs = Date.now();
    return (await partidas([id])).map((t) => [t, proximas(t.departures, refMs).slice(0, 3)]).filter(([, p]) => p.length)
      .map(([t, p]) => chegada(t, p, refMs)).sort((a, b) => a.passagens[0].hora.localeCompare(b.passagens[0].hora));
  }],
  [/^\/api\/rota$/, async (_, q) => {
    const origem = lerCoordenada(q.de), destino = lerCoordenada(q.para);
    if (!origem || !destino) throw new ErroUsuario("Origem e destino devem ser 'lat,lon'.");
    if (distancia(...origem, ...destino) < 300) throw new ErroUsuario("Origem e destino estão praticamente no mesmo lugar, dá para ir a pé.");
    const refMs = Date.now();
    const diretas = (await linhasDiretas(origem, destino, refMs)).slice(0, 8).map((o) => ({
      linha: o.trip.shortName, route_id: o.trip.routeId, trip_id: o.trip.tripId, cor: o.trip.color || "#175898",
      destino: o.trip.headsign || "", embarque: paradaProximaJson(o.parada), desce: paradaViagem(o.desce),
      andar_destino_m: o.andar, passagens: o.prox.slice(0, 3).map(([ms, p]) => passagem(ms, p, refMs, o.trip.stopSequence, o.trip)) }));
    const itinerarios = [];
    if (!diretas.length) {
      for (const it of await planejar(origem, destino)) {
        const onibus = it.legs.filter((l) => l.transitLeg);
        if (!onibus.length) continue;
        itinerarios.push({ duracao_min: Math.round(it.duration / 60), andar_m: it.walkDistance || 0, chega: horaCurtaBrasilia(it.endTime),
          trechos: onibus.map((l) => ({ linha: l.routeShortName || "?", sai: horaCurtaBrasilia(l.startTime), de: l.from.name,
            para: l.to.name, de_integracao: tipoIntegracao(l.from.name), para_integracao: tipoIntegracao(l.to.name) })) });
      }
    }
    return { diretas, itinerarios };
  }],
  [/^\/api\/endereco$/, async (_, q) => {
    const c = lerCoordenada(q.q);
    if (c) return { lat: c[0], lon: c[1], rotulo: "ponto escolhido" };
    let achado = await geocodificar(q.q);
    if (!achado) {
      const p = (await buscarParadas(q.q))[0];
      if (p) achado = [p.lat, p.lng, p.name];
    }
    if (!achado) throw new ErroUsuario(`Não encontrei “${q.q}” no DF. Tente um nome mais específico.`);
    return { lat: achado[0], lon: achado[1], rotulo: achado[2] };
  }],
  [/^\/api\/agora$/, async (_, q) => instantaneo(num(q.lat), num(q.lon), q.linha ?? null, q.parada ?? null)],
];
function num(v) { return v == null || v === "" ? null : Number(v); }

/** Atende um caminho /api/... como o servidor atenderia. Lança ErroUsuario com a mensagem para a tela. */
export async function atender(caminho, params = {}) {
  const q = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  for (const [padrao, fn] of ROTAS) {
    const m = padrao.exec(caminho);
    if (m) {
      try { return await fn(m.map(decodeURIComponent), q); }
      catch (e) {
        if (e instanceof ErroUsuario) throw e;
        throw new ErroUsuario("O serviço de dados do DF no Ponto não respondeu. Tente de novo em instantes.");
      }
    }
  }
  throw new ErroUsuario("Rota desconhecida.");
}
