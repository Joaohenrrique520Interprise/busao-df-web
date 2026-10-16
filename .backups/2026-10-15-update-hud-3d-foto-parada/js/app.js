// Busão DF — app web. Telas: início (perto de mim), linha, parada e rota.
import {
  CONFIANCA, ErroApi, aoVivo, atrasoTexto, bruto, chipLinha, decodificar, distancia, faltaCurta, h, horaCurta,
  html, local, metros, nativo, pedir, segundosAte, selo, sincronizar,
} from "./dados.js";
import { Folha } from "./folha.js";
import { Mapa } from "./mapa.js?v=8";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const conteudo = $("#conteudo");
const VALIDADE_ALERTA_MS = 3 * 3600 * 1000;
const MOVIMENTO_MINIMO_M = 120;     // só reconecta o tempo real se você andou isso
const GPS_PRECISO_M = 100;
const REGIOES_DF = [
  { nome: "Plano Piloto", lat: -15.7939, lon: -47.8828 },
  { nome: "Taguatinga", lat: -15.8339, lon: -48.0563 },
  { nome: "Riacho Fundo I", lat: -15.8829, lon: -48.0151 },
  { nome: "Ceilândia", lat: -15.8170, lon: -48.1070 },
  { nome: "Samambaia", lat: -15.8794, lon: -48.0887 },
  { nome: "Gama", lat: -16.0186, lon: -48.0680 },
];

const estado = {
  pos: null,                 // {lat, lon, origem: "gps"|"endereco", rotulo}
  geo: "pedindo",            // pedindo | ok | negado | expirou | indisponivel
  vista: "inicio",           // inicio | linha | parada | rota
  linha: null,               // LinhaDetalhe da linha aberta
  sentido: null,             // trip_id escolhido
  parada: null,              // parada aberta {id, nome, lat, lon}
  chegadasParada: null,
  ultimo: null,              // último pacote ao vivo
  intervaloS: 15,
  conexao: "parado",
  recebidoMs: 0,
  favoritos: local.ler("favoritos", []),
  locais: local.ler("locais", {}),
  alertas: local.ler("alertas", []).filter((a) => Date.now() - a.criado < VALIDADE_ALERTA_MS),
};

// ================================================================ tema
const ICONE_LUA = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const ICONE_SOL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const tema = () => document.documentElement.dataset.tema;
function pintarBotoesTema() {
  for (const b of $$('[data-acao="tema"]')) b.innerHTML = tema() === "escuro" ? ICONE_SOL : ICONE_LUA;
  $('meta[name="theme-color"]').content = tema() === "escuro" ? "#0b1017" : "#0f1d2e";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest('[data-acao="tema"]')) return;
  document.documentElement.dataset.tema = tema() === "escuro" ? "claro" : "escuro";
  local.gravar("tema", tema());
  pintarBotoesTema();
  mapa.definirTema(tema());
});
pintarBotoesTema();

// ================================================================ mapa e painel
const mapa = new Mapa($("#mapa"), tema(), {
  aoClicarOnibus: (v) => abrirLinha(v.route_id, v.trip_id),
  aoClicarParada: (p) => {
    if (estado.vista === "linha" && estado.linha) definirParada(p.id);
    else if (p.id) abrirParada(p);
    else pedir("/api/paradas/identificar", { nome: p.nome, lat: p.lat, lon: p.lon }).then(abrirParada).catch((e) => avisar(e.message));
  },
});

// Paradas da área visível (fora da tela da linha, que mostra só as paradas dela).
let tempoArea, pedidoArea = 0;
function carregarParadasArea() {
  clearTimeout(tempoArea);
  tempoArea = setTimeout(async () => {
    const a = mapa.area();
    if (estado.vista === "linha" || a.zoom < 13.5) return;   // abaixo disso o mapa nem desenha paradas
    const meu = ++pedidoArea;
    try {
      const lista = await pedir("/api/paradas/area", { lat: a.lat.toFixed(4), lon: a.lon.toFixed(4), raio: Math.min(3000, Math.max(300, a.raio)) });
      if (meu === pedidoArea && estado.vista !== "linha") mapa.paradas(lista);
    } catch { /* fica com as paradas que já estavam */ }
  }, 300);
}
mapa.aoMover(carregarParadasArea);
const folha = new Folha($(".folha"), ({ desktop, visivel }) => {
  mapa.mapa.setPadding(desktop ? { top: 20, bottom: 20, left: 452, right: 20 } : { top: 80, bottom: Math.min(visivel, innerHeight * 0.55), left: 0, right: 0 });
});

// ================================================================ toast
let tempoToast;
function avisar(texto) {
  const t = $(".toast");
  t.textContent = texto;
  t.classList.add("visivel");
  clearTimeout(tempoToast);
  tempoToast = setTimeout(() => t.classList.remove("visivel"), 4200);
}

// ================================================================ localização
let geoWatchId = null;
let erroGeoAvisado = null;

const posicaoAutomatica = (p) => p && (p.origem === "gps" || p.origem === "aproximada");

function falhaGeo(erro) {
  const tipo = erro.code === 1 ? "negado" : erro.code === 3 ? "expirou" : "indisponivel";
  estado.geo = tipo;
  if (tipo === "negado" && geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  if (erroGeoAvisado !== tipo) {
    erroGeoAvisado = tipo;
    avisar({
      negado: "Localização bloqueada. Permita o acesso ou escolha uma região do DF.",
      expirou: "O GPS demorou para responder. Tente novamente ou escolha uma região.",
      indisponivel: "Localização indisponível. Você ainda pode buscar uma linha ou escolher uma região.",
    }[tipo]);
  }
  if (!estado.pos && estado.vista === "inicio") render();
}

function iniciarGeo() {
  if (!("geolocation" in navigator) || !isSecureContext) {
    estado.geo = "indisponivel";
    if (erroGeoAvisado !== "inseguro") {
      erroGeoAvisado = "inseguro";
      avisar("Para usar o GPS no celular, abra o endereço HTTPS do compartilhamento.");
    }
    if (estado.vista === "inicio") render();
    return;
  }
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  estado.geo = "pedindo";
  geoWatchId = navigator.geolocation.watchPosition((p) => {
    // maximumAge: 0 pede uma leitura nova, em vez de reutilizar a posição
    // que o navegador possa ter guardado de uma visita anterior.
    const precisa = Number.isFinite(p.coords.accuracy) && p.coords.accuracy <= GPS_PRECISO_M;
    const novo = {
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      precisao_m: p.coords.accuracy,
      origem: precisa ? "gps" : "aproximada",
      rotulo: "você",
    };
    const primeira = estado.geo !== "ok";
    estado.geo = "ok";
    erroGeoAvisado = null;
    if (estado.pos && !posicaoAutomatica(estado.pos)) return;    // você escolheu um endereço/região: respeita
    const andou = !estado.pos || metros(estado.pos, novo) > MOVIMENTO_MINIMO_M;
    const mudouPrecisao = estado.pos?.origem !== novo.origem;
    mapa.eu(novo);
    if (!andou) {
      estado.pos = novo;
      if (mudouPrecisao && estado.vista === "inicio") render();
      return;
    }
    estado.pos = novo;
    if (primeira && estado.vista === "inicio") mapa.centralizar(novo);
    conectar();
    if (primeira) render();
  }, falhaGeo, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

function definirPosicao(lat, lon, rotulo, origem = "endereco") {
  estado.pos = { lat, lon, origem, rotulo };
  mapa.eu(estado.pos);
  mapa.centralizar(estado.pos);
  conectar();
  render();
}

// ================================================================ tempo real
let fecharVivo = null, chaveVivo = "";
function conectar() {
  const linha = estado.linha?.linha.id;
  const parada = linha ? estado.escolhida : null;
  const chave = `${estado.pos?.lat},${estado.pos?.lon},${linha},${parada}`;
  if (fecharVivo && chave === chaveVivo && estado.conexao !== "erro") return;   // já está ouvindo isso
  fecharVivo?.();
  fecharVivo = null;
  chaveVivo = chave;
  estado.ultimoLinha = undefined;
  if (!estado.pos && !linha) { definirConexao("parado"); return; }
  fecharVivo = aoVivo({ lat: estado.pos?.lat, lon: estado.pos?.lon, linha, parada }, {
    dados: (d) => { estado.ultimoLinha = linha; receber(d); },
    config: (c) => { estado.intervaloS = c.intervalo_s; },
    erro: () => definirConexao("erro"),
    estado: definirConexao,
  });
}

function definirConexao(c) { estado.conexao = c; pintarStatus(); }

function pintarStatus() {
  const el = $(".status");
  const idade = Math.round((Date.now() - estado.recebidoMs) / 1000);
  let c = estado.conexao, texto;
  if (!navigator.onLine) c = "offline";
  if (c === "ok" && idade > estado.intervaloS * 2 + 10) c = "conectando";
  texto = { ok: `Ao vivo · há ${idade} s`, conectando: "Reconectando…", erro: "DF no Ponto sem resposta", offline: "Sem internet", parado: "" }[c];
  el.dataset.estado = c;
  el.classList.toggle("oculto", c === "parado");
  el.lastElementChild.textContent = texto;
}
addEventListener("online", () => { pintarStatus(); conectar(); });
addEventListener("offline", pintarStatus);

function receber(d) {
  sincronizar(d.ts);
  estado.ultimo = d;
  estado.recebidoMs = Date.now();
  pintarStatus();
  pintarMapa();
  atualizarPartes();
}

const minhaAtual = () => estado.ultimo?.minha.find((m) => m.trip_id === estado.sentido) ?? null;

function pintarMapa() {
  const d = estado.ultimo;
  if (!d) return;
  if (estado.vista === "linha" && estado.linha) {
    const daLinha = d.veiculos.filter((v) => v.trip_id === estado.sentido);
    mapa.veiculos(daLinha, minhaAtual()?.veiculo_proximo, estado.intervaloS);
  } else {
    mapa.veiculos(d.veiculos, null, estado.intervaloS);
  }
}

// ================================================================ navegação
function irPara(vista) {
  estado.vista = vista;
  if (vista !== "linha") { mapa.trajeto(null); mapa.minhaParada(null); carregarParadasArea(); }
  render();
  conteudo.scrollTop = 0;
}

async function abrirLinha(routeId, tripId = null) {
  fecharSugestoes();
  estado.vista = "linha";
  estado.linha = null;
  render();        // esqueleto
  folha.ir("meio");
  try {
    const det = await pedir(`/api/linhas/${encodeURIComponent(routeId)}`);
    estado.linha = det;
    const salvo = local.ler(`sentido:${routeId}`, null);
    const validos = det.sentidos.map((s) => s.trip_id);
    estado.sentido = [tripId, salvo].find((t) => t && validos.includes(t)) ?? validos[0];
    estado.escolhida = local.ler(`parada:${routeId}`, null);
    render();
    pintarLinhaNoMapa(true);
    conectar();
  } catch (e) {
    conteudo.innerHTML = html(telaErro(e.message, "voltar"));
  }
}

// Parada escolhida à mão para a linha aberta (null = a mais perto de mim).
function definirParada(stopId) {
  const l = estado.linha.linha;
  estado.escolhida = stopId;
  local.gravar(`parada:${l.id}`, stopId);
  // Se a parada é do outro sentido, muda o sentido junto.
  const dono = estado.linha.sentidos.find((s) => s.paradas.some((p) => p.id === stopId));
  if (stopId && dono && dono.trip_id !== estado.sentido) {
    estado.sentido = dono.trip_id;
    local.gravar(`sentido:${l.id}`, estado.sentido);
    render();
    pintarLinhaNoMapa(false);
  } else {
    trocarParte("escolha", h``);
  }
  conectar();
  trocarParte("heroi", parteHeroi());
  avisar(stopId ? "Parada escolhida. Vou acompanhar o ônibus nela." : "Voltei a usar a parada mais perto de você.");
}

function pintarLinhaNoMapa(enquadrar) {
  const s = estado.linha?.sentidos.find((x) => x.trip_id === estado.sentido);
  if (!s) return;
  const coords = s.tracado ? decodificar(s.tracado) : s.paradas.map((p) => [p.lon, p.lat]);
  mapa.trajeto(coords, estado.linha.linha.cor);
  mapa.paradas(s.paradas, estado.linha.linha.cor);
  const minha = minhaAtual();
  mapa.minhaParada(minha?.parada ?? null);
  if (enquadrar) mapa.enquadrar(estado.pos ? [...coords, [estado.pos.lon, estado.pos.lat]] : coords);
  pintarMapa();
}

async function abrirParada(p) {
  fecharSugestoes();
  estado.parada = p;
  estado.chegadasParada = null;
  estado.linha = null;
  irPara("parada");
  mapa.minhaParada(p);
  mapa.centralizar(p, 16);
  conectar();
  await carregarChegadasParada();
}

async function carregarChegadasParada() {
  const p = estado.parada;
  try {
    const lista = await pedir(`/api/paradas/${encodeURIComponent(p.id)}/chegadas`);
    if (estado.parada !== p) return;
    estado.chegadasParada = lista;
  } catch (e) {
    estado.chegadasParada = { erro: e.message };
  }
  if (estado.vista === "parada") trocarParte("chegadas", parteChegadasParada());
}

function abrirRota(para = "") {
  fecharSugestoes();
  estado.linha = null;
  irPara("rota");
  conectar();
  if (para) { $('[name="para"]', conteudo).value = para; calcularRota(); }
}

// ================================================================ telas
function render() {
  const tela = { inicio: telaInicio, linha: telaLinha, parada: telaParada, rota: telaRota }[estado.vista];
  conteudo.innerHTML = `<div class="vista">${html(tela())}</div>`;
  contar();
}

function trocarParte(nome, frag) {
  const el = conteudo.querySelector(`[data-parte="${nome}"]`);
  if (el) { el.innerHTML = html(frag); contar(); }
}

function atualizarPartes() {
  if (estado.vista === "inicio") trocarParte("perto", partePerto());
  if (estado.vista === "linha" && estado.linha) {
    trocarParte("heroi", parteHeroi());
    mapa.minhaParada(minhaAtual()?.parada ?? null);
  }
  if (estado.vista === "parada") carregarChegadasParada();
}

const ICONE = {
  voltar: bruto('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>'),
  pino: bruto('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.3 7-12a7 7 0 1 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="10" r="2.6"/></svg>'),
  estrela: bruto('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>'),
  sino: bruto('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>'),
  info: bruto('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>'),
  rota: bruto('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/></svg>'),
  onibus: bruto('<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 21v-3M16 21v-3"/></svg>'),
  mira: bruto('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>'),
};

const esqueleto = (n = 3) => h`${Array.from({ length: n }, (_, i) => h`<div class="esqueleto" style="height:${i ? 92 : 120}px;margin-bottom:10px"></div>`)}`;

function telaErro(msg, acao = "tentar") {
  return h`<div class="vazio"><div class="ilustra">${ICONE.info}</div><b>Não deu certo</b><p>${msg}</p>
    <button class="botao secundario" data-acao="${acao}">${acao === "voltar" ? "Voltar" : "Tentar de novo"}</button></div>`;
}

const formEndereco = (rotulo = "Onde você está?") => h`
  <form data-form="endereco" class="campo" style="margin-top:6px">
    <label for="end-aqui" class="sr">${rotulo}</label>
    ${ICONE.pino}
    <input id="end-aqui" name="q" placeholder="${rotulo} (ex.: Quadra 101 Recanto)" required minlength="2" autocomplete="street-address">
    <button class="botao acento" style="height:38px;padding:0 14px">Usar</button>
  </form>`;

const blocoRegioes = () => h`
  <h3>Escolher uma região do DF</h3>
  <p class="sub" style="margin-bottom:8px">Mostra as paradas próximas ao centro da região; depois você pode ajustar pelo mapa.</p>
  <div class="chips regioes">${REGIOES_DF.map((r) => h`
    <button class="chip sem-chip" data-acao="selecionar-regiao" data-nome="${r.nome}" data-lat="${r.lat}" data-lon="${r.lon}">${ICONE.pino} ${r.nome}</button>`)}</div>`;

function indicadorPosicao() {
  const p = estado.pos;
  if (!p) return h``;
  if (p.origem === "gps") return h`<span class="origem-posicao precisa">${ICONE.mira} GPS preciso${Number.isFinite(p.precisao_m) ? ` · ±${Math.round(p.precisao_m)} m` : ""}</span>`;
  if (p.origem === "aproximada") {
    const margem = Number.isFinite(p.precisao_m) ? p.precisao_m >= 1000 ? ` · ±${(p.precisao_m / 1000).toFixed(1).replace(".", ",")} km` : ` · ±${Math.round(p.precisao_m)} m` : "";
    return h`<span class="origem-posicao aproximada">${ICONE.info} Aproximação pela rede/IP${margem}</span>`;
  }
  return h`<span class="origem-posicao manual">${ICONE.pino} ${p.origem === "regiao" ? "Região selecionada" : "Local informado manualmente"}</span>`;
}

const legendaCoresOnibus = () => h`
  <details class="legenda-onibus">
    <summary>O que significam as cores dos ônibus?</summary>
    <div class="legenda-itens">
      <span><i class="cor verde" aria-hidden="true"></i><b>Verde</b> — no horário</span>
      <span><i class="cor laranja" aria-hidden="true"></i><b>Laranja/amarelo</b> — atrasado 3 min ou mais</span>
      <span><i class="cor azul" aria-hidden="true"></i><b>Azul</b> — adiantado 2 min ou mais</span>
      <span><i class="cor cinza" aria-hidden="true"></i><b>Cinza</b> — GPS sem atualização há mais de 2 min</span>
    </div>
    <p>As cores das etiquetas com o número identificam a linha. Os quadrados amarelos no mapa são paradas.</p>
  </details>`;

// ---------------------------------------------------------------- início
function telaInicio() {
  if (!estado.pos) {
    if (estado.geo === "pedindo") return h`<h2>Procurando você…</h2><p class="sub">Permita o acesso à localização para ver as paradas e ônibus perto.</p><div style="margin-top:16px">${esqueleto(2)}</div>`;
    const negado = estado.geo === "negado";
    const semHttps = !isSecureContext;
    return h`<div class="vazio"><div class="ilustra">${ICONE.pino}</div>
      <b>${semHttps ? "Abra pelo link HTTPS para usar sua localização" : negado ? "Permita o acesso à sua localização" : "Não consegui achar sua localização"}</b>
      <p>${semHttps
        ? "O iPhone bloqueia o GPS neste endereço HTTP. Abra o link HTTPS gerado por compartilhar.bat; o aplicativo pedirá permissão e encontrará você automaticamente."
        : negado
          ? "Autorize a localização nas configurações do navegador e toque em tentar novamente."
          : "Confira se a localização do aparelho está ligada e tente novamente."}</p></div>
      <p class="sub" style="margin:14px 0 4px">${semHttps ? "Enquanto isso, você também pode informar um local manualmente:" : "Se preferir, informe o local manualmente:"}</p>
      ${formEndereco()}
      ${semHttps ? "" : h`<button class="botao secundario largo" data-acao="tentar-geo" style="margin-top:4px">Tentar localização de novo</button>`}
      ${blocoRegioes()}
      ${blocoAtalhos()}`;
  }
  const deEndereco = !posicaoAutomatica(estado.pos);
  return h`
    <h2>${deEndereco ? `Perto de ${estado.pos.rotulo}` : "Perto de você"}</h2>
    <p class="sub">Paradas a poucos passos e o que está chegando.</p>
    ${indicadorPosicao()}
    ${deEndereco && estado.geo !== "negado" ? h`<button class="chip sem-chip" data-acao="usar-gps" style="margin-top:10px">${ICONE.mira} Usar minha localização</button>` : ""}
    ${legendaCoresOnibus()}
    ${blocoAtalhos()}
    <h3>Paradas perto</h3>
    <div data-parte="perto">${partePerto()}</div>
    <button class="cartao clicavel" data-acao="abrir-rota" style="display:flex;align-items:center;gap:12px;margin-top:6px">
      <span class="minha-parada" style="padding:0"><span class="pino">${ICONE.rota}</span></span>
      <span><b style="display:block;font-size:15px">Como chegar a um lugar</b><span class="sub">Linhas diretas, onde pegar e onde descer</span></span>
    </button>`;
}

function blocoAtalhos() {
  const favs = estado.favoritos;
  const locais = Object.entries(estado.locais);
  return h`
    ${favs.length ? h`<h3>Linhas favoritas</h3><div class="chips">${favs.map((f) => h`
      <button class="chip" data-acao="abrir-linha" data-route="${f.id}">${chipLinha(f.numero, f.cor, f.cor_texto)}<span>${f.nome.split("/")[0]}</span></button>`)}</div>` : ""}
    <h3>Meus lugares</h3>
    <div class="chips">
      ${locais.map(([nome]) => h`<button class="chip sem-chip" data-acao="rota-para" data-nome="${nome}">${ICONE.pino} Ir para ${nome}</button>`)}
      ${estado.pos ? h`<button class="chip sem-chip" data-acao="mostrar-salvar">+ Salvar este lugar</button>` : ""}
      ${!locais.length && !estado.pos ? h`<span class="sub">Salve casa e trabalho para ir mais rápido.</span>` : ""}
    </div>
    <form data-form="salvar-local" class="campo oculto" style="margin-top:8px">
      <label for="nome-local" class="sr">Nome do lugar</label>
      <input id="nome-local" name="nome" placeholder="Nome (ex.: casa, trabalho)" required maxlength="30">
      <button class="botao acento" style="height:38px;padding:0 14px">Salvar</button>
    </form>`;
}

function partePerto() {
  const d = estado.ultimo;
  if (!d) return esqueleto(3);
  if (!d.paradas.length) return h`<div class="vazio"><div class="ilustra">${ICONE.onibus}</div><b>Nenhuma parada por perto</b><p>Não há parada de ônibus a menos de 1,2 km deste ponto.</p></div>`;
  return h`${d.paradas.map((pc) => {
    const p = pc.parada;
    const mostra = pc.chegadas.slice(0, 4);
    return h`<article class="cartao parada-cartao">
      <header><b>${p.nome}</b><span class="dist">${distancia(p.dist_m)}</span></header>
      ${mostra.length ? mostra.map(linhaChegada) : h`<p class="sub">Sem previsão de ônibus agora.</p>`}
      <button class="chegada" data-acao="abrir-parada" data-id="${p.id}" data-nome="${p.nome}" data-lat="${p.lat}" data-lon="${p.lon}">
        <span class="mais">${pc.chegadas.length > 4 ? `Ver todas as ${pc.chegadas.length} linhas →` : "Ver parada →"}</span></button>
    </article>`;
  })}`;
}

function linhaChegada(c) {
  const p = c.passagens[0];
  return h`<button class="chegada" data-acao="abrir-linha" data-route="${c.route_id}" data-trip="${c.trip_id}" aria-label="Linha ${c.linha} para ${c.destino}, ${CONFIANCA[p.confianca].rotulo}">
    ${chipLinha(c.linha, c.cor)}
    <span class="meio"><span class="destino">${c.destino}</span><span class="selos-linha">${selo(p.confianca)}${selosConforto(p)}</span></span>
    <span class="quando" data-cont="${p.hora}" data-modo="curta">${faltaCurta(p.hora)}</span>
  </button>`;
}

const selosConforto = (item = {}) => h`${item.acessivel
  ? h`<span class="selo-recurso acessivel" title="Veículo acessível para cadeirantes" aria-label="Veículo acessível">♿ Acessível</span>` : ""}${item.ar_condicionado
  ? h`<span class="selo-recurso ar" title="Veículo com ar-condicionado" aria-label="Veículo com ar-condicionado">❄ Ar</span>` : ""}`;

const badgeIntegracao = (integracao) => integracao ? h`<span class="badge-integracao ${integracao.tipo}"
  title="Integração com ${integracao.rotulo}">${integracao.tipo === "metro" ? "M" : "BRT"} · ${integracao.rotulo}</span>` : h``;

const distanciaOnibus = (p) => p.paradas_restantes != null
  ? `${p.paradas_restantes} ${p.paradas_restantes === 1 ? "parada" : "paradas"}`
  : p.distancia_onibus_m != null ? distancia(p.distancia_onibus_m) : null;

// ---------------------------------------------------------------- linha
function telaLinha() {
  const det = estado.linha;
  if (!det) return h`<button class="voltar" data-acao="voltar">${ICONE.voltar} Voltar</button><div style="margin-top:8px">${esqueleto(3)}</div>`;
  const l = det.linha;
  const fav = estado.favoritos.some((f) => f.id === l.id);
  const sentido = det.sentidos.find((s) => s.trip_id === estado.sentido);
  return h`
    <button class="voltar" data-acao="voltar">${ICONE.voltar} Voltar</button>
    <div style="display:flex;gap:12px;align-items:flex-start">
      ${chipLinha(l.numero, l.cor, l.cor_texto, true)}
      <div style="flex:1;min-width:0"><h2 style="font-size:17px;margin:0">${l.nome}</h2>
        <p class="sub" style="font-size:13px">${l.operadora}${l.preco ? ` · R$ ${l.preco.toFixed(2).replace(".", ",")}` : ""}</p>
        <div class="selos-linha">${selosConforto(l)}</div></div>
      <button class="icone-botao" data-acao="favoritar" aria-pressed="${fav}" aria-label="${fav ? "Remover dos favoritos" : "Favoritar linha"}">${ICONE.estrela}</button>
    </div>
    ${det.sentidos.length > 1 ? h`<div class="sentidos" role="group" aria-label="Sentido">${det.sentidos.map((s) => h`
      <button data-acao="sentido" data-trip="${s.trip_id}" aria-pressed="${s.trip_id === estado.sentido}">→ ${s.destino.replace(/\s*\(.*\)$/, "")}</button>`)}</div>` : ""}
    <div data-parte="heroi">${parteHeroi()}</div>
    <div data-parte="escolha"></div>
    ${sentido?.saidas_terminal.length ? h`<h3>Saídas do terminal (tabela)</h3><p class="sub">${sentido.saidas_terminal.join(" · ")}</p>` : ""}`;
}

function parteHeroi() {
  const l = estado.linha.linha;
  const botaoEscolher = h`<button class="botao secundario largo" data-acao="escolher-parada" style="margin-top:8px">${ICONE.pino} Escolher a parada na lista</button>`;
  if (!estado.pos && !estado.escolhida) return h`<div class="heroi vazio" style="--cor:${l.cor}"><p class="rotulo">Quando passa na sua parada?</p>
      <p class="sub">Ative a localização ou digite onde você está para eu achar a parada mais perto, ou escolha a parada você mesmo.</p></div>${formEndereco()}${botaoEscolher}`;
  if (estado.ultimoLinha !== l.id) return esqueleto(2);     // ainda não chegou o primeiro pacote desta linha
  const m = minhaAtual();
  if (!m) return h`<div class="vazio"><div class="ilustra">${ICONE.pino}</div>
    <b>${estado.pos ? "Esta linha não passa perto de você" : "Sua parada é do outro sentido"}</b>
    <p>${estado.pos ? "Neste sentido, a parada mais próxima fica a mais de 1,2 km. Tente o outro sentido ou escolha a parada." : "Escolha uma parada deste sentido."}</p></div>${botaoEscolher}`;

  const comoAchei = m.escolhida ? "Escolhida por você" : "Mais perto de você";
  const andar = h`<div class="minha-parada"><span class="pino">${ICONE.pino}</span>
    <div style="flex:1;min-width:0"><b>${m.parada.nome}</b><span>${comoAchei}${m.parada.dist_m != null ? ` · ${distancia(m.parada.dist_m)} · ~${m.andar_min} min a pé` : ""}</span>
      <span style="display:flex;gap:6px;margin-top:6px">
        <button class="chip sem-chip" style="height:32px" data-acao="escolher-parada">Trocar parada</button>
        ${m.escolhida && estado.pos ? h`<button class="chip sem-chip" style="height:32px" data-acao="parada-auto">Usar a mais perto</button>` : ""}
      </span></div></div>`;
  if (!m.passagens.length) return h`<div class="heroi vazio" style="--cor:${l.cor}"><p class="rotulo">Passa na sua parada</p><p class="tempo">Sem previsão agora</p>
    <p class="sub">A API não tem próximos horários para esta parada neste sentido.</p></div>${andar}`;

  const [p, ...resto] = m.passagens;
  const vivo = m.passagens.some((x) => x.confianca === "gps" || x.confianca === "gps_velho");
  const atraso = m.atraso_s != null && (p.confianca === "gps" || p.confianca === "gps_velho") ? atrasoTexto(m.atraso_s) : null;
  const folga = m.andar_min == null ? Infinity : segundosAte(p.hora) / 60 - m.andar_min;   // minutos que sobram depois de andar
  const alerta = estado.alertas.find((a) => a.trip === m.trip_id && a.stop === m.parada.id);
  return h`
    <div class="heroi" style="--cor:${l.cor}">
      <p class="rotulo">Passa na sua parada em</p>
      <p class="tempo" data-cont="${p.hora}" data-modo="heroi" aria-live="off">${faltaCurta(p.hora)}</p>
      <div class="linha-info">${selo(p.confianca)}
        ${selosConforto(p)}
        ${atraso ? h`<span class="atraso ${atraso.classe}">${atraso.texto}</span>` : ""}
        <span>às ${horaCurta(p.hora)}</span>
        ${distanciaOnibus(p) ? h`<span class="proximidade">· ${distanciaOnibus(p)} de distância</span>` : ""}</div>
    </div>
    ${!vivo ? h`<div class="aviso-tabela${p.confianca === "fantasma" ? " forte" : ""}">${ICONE.info}<span>${p.confianca === "fantasma"
      ? h`<b>Sem ônibus no GPS.</b> O das ${horaCurta(p.hora)} já devia ter saído do terminal e não aparece: pode não passar.`
      : h`<b>Sem ônibus no GPS — previsão pela tabela.</b> O horário é o programado, não a posição real.`}</span></div>` : ""}
    ${andar}
    ${folga < 0 ? h`<p class="correr" style="margin:0 0 6px">A pé leva ~${m.andar_min} min: este você provavelmente perde.</p>`
      : folga < 3 ? h`<p class="correr" style="margin:0 0 6px">Saia agora: a caminhada leva ~${m.andar_min} min.</p>` : ""}
    ${resto.length ? h`<h3>Depois</h3><ul class="passagens">${resto.map((x) => h`<li>
      <span class="quando" data-cont="${x.hora}" data-modo="curta">${faltaCurta(x.hora)}</span>${selo(x.confianca)}${selosConforto(x)}<span class="hora">${horaCurta(x.hora)}</span></li>`)}</ul>` : ""}
    ${alerta
      ? h`<div class="aviso-linha"><button class="botao secundario largo" data-acao="cancelar-alerta">${ICONE.sino} ${alerta.modo === "proximidade" ? "Aviso quando estiver chegando ativo" : `Aviso a ${alerta.minutos} min ativo`} · cancelar</button></div>`
      : h`<div class="alertas-opcoes"><button class="botao largo" data-acao="alerta-proximidade">${ICONE.sino} Me avise quando estiver chegando</button>
        <form class="aviso-linha" data-form="alerta"><button class="botao secundario">Avisar quando faltar</button>
          <label class="sr" for="min-alerta">Minutos</label>
          <select id="min-alerta" name="minutos">${[3, 5, 7, 10, 15].map((n) => h`<option value="${n}" ${n === Math.max(5, (m.andar_min ?? 0) + 1) || (n === 5 && (m.andar_min ?? 0) < 4) ? "selected" : ""}>${n} min</option>`)}</select></form></div>`}`;
}

const normalizar = (t) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

function parteEscolha() {
  const s = estado.linha.sentidos.find((x) => x.trip_id === estado.sentido);
  return h`<div class="cartao" style="margin-top:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <b>Escolha sua parada</b><button class="chip sem-chip" style="height:32px" data-acao="fechar-escolha">Fechar</button></div>
    <p class="sub" style="font-size:13px;margin-bottom:8px">Paradas do sentido → ${s.destino}, na ordem do trajeto. Também dá para tocar numa parada no mapa.</p>
    <div class="campo"><label for="filtro-paradas" class="sr">Filtrar paradas</label>
      <input id="filtro-paradas" data-filtro-paradas placeholder="Filtrar (ex.: quadra 306, rodoviária)" autocomplete="off"></div>
    <ol class="passagens" style="max-height:340px;overflow:auto">${s.paradas.map((p, i) => {
      const dist = estado.pos ? metros(estado.pos, p) : null;
      return h`<li data-nome="${normalizar(p.nome)}"><button class="chegada" data-acao="definir-parada" data-id="${p.id}" style="border:0;padding:0">
        <span class="dist" style="min-width:34px;text-align:center">${i + 1}</span>
        <span class="meio"><span class="destino" style="white-space:normal">${p.nome}</span>${badgeIntegracao(p.integracao)}</span>
        ${dist != null ? h`<span class="mudo" style="font-size:13px;font-weight:700">${distancia(dist)}</span>` : ""}
        ${p.id === estado.escolhida ? h`<span class="selo selo-gps">Sua</span>` : ""}</button></li>`;
    })}</ol></div>`;
}

conteudo.addEventListener("input", (e) => {
  if (!e.target.matches("[data-filtro-paradas]")) return;
  const q = normalizar(e.target.value.trim());
  for (const li of $$("[data-nome]", conteudo)) li.classList.toggle("oculto", Boolean(q) && !li.dataset.nome.includes(q));
});

// ---------------------------------------------------------------- parada
function telaParada() {
  const p = estado.parada;
  const dist = estado.pos ? metros(estado.pos, p) : null;
  return h`
    <button class="voltar" data-acao="voltar">${ICONE.voltar} Voltar</button>
    <h2>${p.nome}</h2>
    <p class="sub">${dist != null ? `${distancia(dist)} de ${estado.pos.origem === "gps" ? "você" : estado.pos.rotulo}` : "Parada de ônibus"}</p>
    <h3>Próximas chegadas</h3>
    <div data-parte="chegadas">${parteChegadasParada()}</div>`;
}

function parteChegadasParada() {
  const c = estado.chegadasParada;
  if (!c) return esqueleto(3);
  if (c.erro) return telaErro(c.erro);
  if (!c.length) return h`<div class="vazio"><div class="ilustra">${ICONE.onibus}</div><b>Nenhum ônibus previsto</b><p>Não há próximas passagens nesta parada agora.</p></div>`;
  return h`<div class="cartao parada-cartao">${c.map(linhaChegada)}</div>`;
}

// ---------------------------------------------------------------- rota
function telaRota() {
  const locais = Object.keys(estado.locais);
  return h`
    <button class="voltar" data-acao="voltar">${ICONE.voltar} Voltar</button>
    <h2>Como chegar</h2>
    <form data-form="rota" style="margin-top:12px">
      <div class="campo"><label for="rota-de">De</label><input id="rota-de" name="de" value="${estado.pos ? (estado.pos.origem === "gps" ? "Minha localização" : estado.pos.rotulo) : ""}" placeholder="Endereço de saída" required></div>
      <div class="campo"><label for="rota-para">Para</label><input id="rota-para" name="para" placeholder="Endereço ou lugar (ex.: Rodoviária)" required></div>
      ${locais.length ? h`<div class="chips" style="margin:2px 0 10px">${locais.map((n) => h`<button type="button" class="chip sem-chip" data-acao="preencher-para" data-nome="${n}">${n}</button>`)}
        ${locais.map((n) => h`<button type="button" class="chip sem-chip mudo" data-acao="remover-local" data-nome="${n}" aria-label="Apagar ${n}">✕ ${n}</button>`)}</div>` : ""}
      <button class="botao acento largo">Ver ônibus</button>
    </form>
    <div data-parte="resultado" style="margin-top:14px"></div>`;
}

async function resolverLugar(texto) {
  const t = texto.trim();
  if (!t || /^minha localiza/i.test(t) || (estado.pos && t === estado.pos.rotulo)) {
    if (!estado.pos) throw new ErroApi("Diga de onde você sai: ative a localização ou digite um endereço.");
    return estado.pos;
  }
  const salvo = estado.locais[t.toLowerCase()];
  if (salvo) return { ...salvo, rotulo: t };
  const e = await pedir("/api/endereco", { q: t });
  return { lat: e.lat, lon: e.lon, rotulo: e.rotulo };
}

async function calcularRota() {
  const form = $('[data-form="rota"]', conteudo);
  trocarParte("resultado", esqueleto(3));
  try {
    const [de, para] = await Promise.all([resolverLugar(form.de.value), resolverLugar(form.para.value)]);
    const r = await pedir("/api/rota", { de: `${de.lat},${de.lon}`, para: `${para.lat},${para.lon}` });
    mapa.enquadrar([[de.lon, de.lat], [para.lon, para.lat]]);
    trocarParte("resultado", parteRota(r, de, para));
  } catch (e) {
    trocarParte("resultado", telaErro(e.message));
  }
}

function parteRota(r, de, para) {
  const cab = h`<p class="sub" style="margin-bottom:10px"><b>${de.rotulo === "você" ? "Você" : de.rotulo}</b> → <b>${para.rotulo}</b></p>`;
  if (r.diretas.length) return h`${cab}<h3 style="margin-top:4px">Linhas diretas</h3>${r.diretas.map((o) => {
    const p = o.passagens[0];
    return h`<button class="cartao clicavel" data-acao="abrir-linha" data-route="${o.route_id}" data-trip="${o.trip_id}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">${chipLinha(o.linha, o.cor)}
        <span class="destino" style="flex:1;min-width:0;font-weight:700;font-size:14px;color:var(--texto-2)">→ ${o.destino}</span></div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
        <span style="font-size:30px;font-weight:800;letter-spacing:-.03em" data-cont="${p.hora}" data-modo="curta">${faltaCurta(p.hora)}</span>
        ${selo(p.confianca)}<span class="mudo" style="font-weight:700;margin-left:auto">${horaCurta(p.hora)}</span></div>
      <div class="trecho"><span class="ponto" style="border-color:${o.cor}"></span><span><span class="etiqueta">Pegue em</span><br>${o.embarque.nome} ${badgeIntegracao(o.embarque.integracao)} · ${distancia(o.embarque.dist_m)}</span></div>
      <div class="trecho"><span class="ponto" style="border-color:${o.cor};background:${o.cor}"></span><span><span class="etiqueta">Desça em</span><br>${o.desce.nome} ${badgeIntegracao(o.desce.integracao)} · +${distancia(o.andar_destino_m)} a pé</span></div>
      ${o.passagens.length > 1 ? h`<p class="sub" style="font-size:13px;margin-top:6px">Depois: ${o.passagens.slice(1).map((x, i) => h`${i ? " · " : ""}${horaCurta(x.hora)} (${CONFIANCA[x.confianca].rotulo.toLowerCase()})`)}</p>` : ""}
    </button>`;
  })}`;
  if (r.itinerarios.length) return h`${cab}<div class="aviso-tabela">${ICONE.info}<span>Não há linha direta. Estas opções têm baldeação e usam o <b>horário programado</b> (não é posição ao vivo).</span></div>
    ${r.itinerarios.map((it) => h`<div class="cartao">
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">${it.trechos.map((t, i) => h`${i ? h`<span class="mudo">›</span>` : ""}<span class="chip-linha" style="--cor:var(--marca);--cor-texto:var(--superficie)">${t.linha}</span>`)}
        <span class="mudo" style="margin-left:auto;font-weight:700">${it.duracao_min} min · chega ~${it.chega}</span></div>
      ${it.trechos.map((t) => h`<div class="trecho"><span class="ponto"></span><span><b>${t.linha}</b> às ${t.sai} (tabela)<br><span class="sub">${t.de} ${badgeIntegracao(t.de_integracao)} → ${t.para} ${badgeIntegracao(t.para_integracao)}</span></span></div>`)}
      <p class="sub" style="font-size:13px;margin-top:4px">${distancia(it.andar_m)} de caminhada no total</p></div>`)}`;
  return h`${cab}<div class="vazio"><div class="ilustra">${ICONE.rota}</div><b>Nenhum ônibus encontrado</b><p>Não achei linha entre esses pontos agora. Tente um destino mais próximo de uma via principal.</p></div>`;
}

// ================================================================ contagem regressiva (1 s)
function contar() {
  for (const el of $$("[data-cont]", conteudo)) {
    const iso = el.dataset.cont;
    if (el.dataset.modo !== "heroi") { el.textContent = faltaCurta(iso); continue; }
    const s = Math.max(0, Math.round(segundosAte(iso)));
    if (s <= 30) el.innerHTML = "agora";
    else if (s < 600) el.innerHTML = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}<small>min</small>`;
    else if (s < 3600) el.innerHTML = `${Math.floor(s / 60)}<small>min</small>`;
    else el.innerHTML = `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
  }
}
setInterval(() => { contar(); pintarStatus(); }, 1000);

// ================================================================ ações
conteudo.addEventListener("click", (e) => {
  const b = e.target.closest("[data-acao]");
  if (!b) return;
  const a = b.dataset.acao;
  if (a === "abrir-linha") abrirLinha(b.dataset.route, b.dataset.trip);
  else if (a === "abrir-parada") abrirParada({ id: b.dataset.id, nome: b.dataset.nome, lat: +b.dataset.lat, lon: +b.dataset.lon });
  else if (a === "voltar") { estado.linha = null; estado.parada = null; irPara("inicio"); conectar(); if (estado.pos) mapa.centralizar(estado.pos); }
  else if (a === "tentar") { estado.vista === "parada" ? carregarChegadasParada() : estado.vista === "rota" ? calcularRota() : render(); }
  else if (a === "tentar-geo") iniciarGeo();
  else if (a === "selecionar-regiao") definirPosicao(+b.dataset.lat, +b.dataset.lon, b.dataset.nome, "regiao");
  else if (a === "escolher-parada") {
    trocarParte("escolha", parteEscolha());
    folha.ir("alto");
    $('[data-parte="escolha"]', conteudo).scrollIntoView({ behavior: "smooth", block: "start" });
  }
  else if (a === "fechar-escolha") trocarParte("escolha", h``);
  else if (a === "definir-parada") definirParada(b.dataset.id);
  else if (a === "parada-auto") definirParada(null);
  else if (a === "usar-gps") { estado.pos = null; estado.geo = "pedindo"; mapa.eu(null); render(); iniciarGeo(); }
  else if (a === "abrir-rota") abrirRota();
  else if (a === "rota-para") abrirRota(b.dataset.nome);
  else if (a === "preencher-para") $('[name="para"]', conteudo).value = b.dataset.nome;
  else if (a === "remover-local") { delete estado.locais[b.dataset.nome]; local.gravar("locais", estado.locais); render(); }
  else if (a === "mostrar-salvar") { const f = $('[data-form="salvar-local"]', conteudo); f.classList.remove("oculto"); f.nome.focus(); }
  else if (a === "sentido") {
    estado.sentido = b.dataset.trip;
    local.gravar(`sentido:${estado.linha.linha.id}`, estado.sentido);
    render();
    pintarLinhaNoMapa(true);
  } else if (a === "favoritar") {
    const l = estado.linha.linha;
    const ja = estado.favoritos.some((f) => f.id === l.id);
    estado.favoritos = ja ? estado.favoritos.filter((f) => f.id !== l.id) : [...estado.favoritos, l];
    local.gravar("favoritos", estado.favoritos);
    avisar(ja ? "Removida dos favoritos." : `Linha ${l.numero} nos favoritos.`);
    render();
  } else if (a === "cancelar-alerta") {
    const m = minhaAtual();
    estado.alertas = estado.alertas.filter((x) => !(m && x.trip === m.trip_id && x.stop === m.parada.id));
    local.gravar("alertas", estado.alertas);
    trocarParte("heroi", parteHeroi());
  } else if (a === "alerta-proximidade") criarAlertaProximidade();
});

conteudo.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const tipo = f.dataset.form;
  if (tipo === "rota") calcularRota();
  else if (tipo === "endereco") {
    const botao = f.querySelector("button");
    botao.disabled = true;
    try {
      const end = await pedir("/api/endereco", { q: f.q.value });
      definirPosicao(end.lat, end.lon, end.rotulo.split(",")[0]);
    } catch (err) { avisar(err.message); botao.disabled = false; }
  } else if (tipo === "salvar-local") {
    const nome = f.nome.value.trim().toLowerCase();
    if (!nome || !estado.pos) return;
    estado.locais[nome] = { lat: estado.pos.lat, lon: estado.pos.lon };
    local.gravar("locais", estado.locais);
    avisar(`“${nome}” salvo.`);
    render();
  } else if (tipo === "alerta") criarAlerta(+f.minutos.value);
});

// ================================================================ alertas (notificação do navegador)
let contextoSom = null;

function prepararSom() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  contextoSom ??= new AudioCtx();
  contextoSom.resume?.().catch(() => {});
}

function tocarSomAlerta() {
  if (!contextoSom || contextoSom.state !== "running") return;
  const inicio = contextoSom.currentTime;
  for (const [quando, frequencia] of [[0, 660], [0.18, 880]]) {
    const oscilador = contextoSom.createOscillator(), ganho = contextoSom.createGain();
    oscilador.frequency.value = frequencia;
    ganho.gain.setValueAtTime(0.0001, inicio + quando);
    ganho.gain.exponentialRampToValueAtTime(0.055, inicio + quando + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + quando + 0.14);
    oscilador.connect(ganho).connect(contextoSom.destination);
    oscilador.start(inicio + quando);
    oscilador.stop(inicio + quando + 0.15);
  }
}

async function pedirPermissaoAlerta() {
  prepararSom();
  if (nativo && notificacoesNativas()) {
    return (await notificacoesNativas().requestPermissions().catch(() => ({}))).display === "granted";
  }
  if (!("Notification" in window)) return false;
  return Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
}

function gravarAlerta(alerta) {
  estado.alertas = estado.alertas.filter((a) => !(a.trip === alerta.trip && a.stop === alerta.stop));
  estado.alertas.push(alerta);
  local.gravar("alertas", estado.alertas);
  trocarParte("heroi", parteHeroi());
}

async function criarAlerta(minutos) {
  const m = minhaAtual();
  if (!m) return;
  const permitido = await pedirPermissaoAlerta();
  const l = estado.linha.linha;
  gravarAlerta({ route: l.id, linha: l.numero, trip: m.trip_id, stop: m.parada.id, destino: m.destino,
    modo: "tempo", minutos, criado: Date.now() });
  avisar(permitido ? `Vou avisar quando o ${l.numero} estiver a ${minutos} min. Deixe o app aberto.`
    : `Notificações bloqueadas: vou avisar só aqui na tela, com o app aberto.`);
}

async function criarAlertaProximidade() {
  const m = minhaAtual();
  if (!m) return;
  const permitido = await pedirPermissaoAlerta();
  const l = estado.linha.linha;
  gravarAlerta({ route: l.id, linha: l.numero, trip: m.trip_id, stop: m.parada.id, destino: m.destino,
    modo: "proximidade", limite_paradas: 3, raio_m: 1200, criado: Date.now() });
  avisar(permitido ? `Vou avisar quando o ${l.numero} estiver a 2 ou 3 paradas. Deixe o app aberto.`
    : `Notificações bloqueadas: o aviso aparecerá aqui enquanto o app estiver aberto.`);
  verificarAlertas();
}

const notificacoesNativas = () => window.Capacitor?.Plugins?.LocalNotifications;

async function notificar(titulo, corpo) {
  navigator.vibrate?.([200, 100, 200]);
  tocarSomAlerta();
  avisar(`${titulo} — ${corpo}`);
  if (nativo && notificacoesNativas()) {
    await notificacoesNativas().schedule({ notifications: [{ id: Date.now() % 2147483647, title: titulo, body: corpo }] }).catch(() => {});
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(titulo, { body: corpo, icon: "/icones/icone-192.png", tag: titulo });
    else new Notification(titulo, { body: corpo, icon: "/icones/icone-192.png" });
  } catch { /* o toast já avisou */ }
}

async function verificarAlertas() {
  if (!estado.alertas.length) return;
  const restam = [];
  for (const a of estado.alertas) {
    if (Date.now() - a.criado > VALIDADE_ALERTA_MS) continue;
    try {
      const minhas = await pedir(`/api/linhas/${encodeURIComponent(a.route)}/minha-parada`,
        { lat: estado.pos?.lat, lon: estado.pos?.lon, parada: a.stop });
      const m = minhas.find((x) => x.trip_id === a.trip && x.parada.id === a.stop);
      // Ignora "pode não passar": avisar de um ônibus que talvez nem exista é pior que não avisar.
      const p = m?.passagens.find((x) => x.confianca !== "fantasma");
      const porParadas = p?.veiculo && p.paradas_restantes != null && p.paradas_restantes <= (a.limite_paradas ?? 3);
      const porRaio = p?.veiculo && p.paradas_restantes == null && p.distancia_onibus_m != null && p.distancia_onibus_m <= (a.raio_m ?? 1200);
      const deveAvisar = a.modo === "proximidade" ? porParadas || porRaio : p && segundosAte(p.hora) / 60 <= a.minutos;
      if (deveAvisar) {
        const proximidade = p.paradas_restantes != null
          ? `${p.paradas_restantes || "menos de uma"} ${p.paradas_restantes === 1 ? "parada" : "paradas"}`
          : `${distancia(p.distancia_onibus_m)} da parada`;
        const corpo = a.modo === "proximidade"
          ? `Está a ${proximidade}. Previsão: ${faltaCurta(p.hora)}.`
          : `${faltaCurta(p.hora)} na sua parada (${CONFIANCA[p.confianca].rotulo.toLowerCase()}).`;
        await notificar(`${a.linha} chegando`, corpo);
        continue;
      }
    } catch { /* tenta no próximo ciclo */ }
    restam.push(a);
  }
  if (restam.length !== estado.alertas.length) {
    estado.alertas = restam;
    local.gravar("alertas", restam);
    if (estado.vista === "linha" && estado.linha) trocarParte("heroi", parteHeroi());
  }
}
setInterval(verificarAlertas, 20000);

// ================================================================ busca
let tempoBusca;
const fecharSugestoes = () => $$(".sugestoes").forEach((s) => s.classList.add("oculto"));
document.addEventListener("click", (e) => { if (!e.target.closest("[data-busca]")) fecharSugestoes(); });

for (const caixa of $$("[data-busca]")) {
  const input = $("input", caixa), lista = $(".sugestoes", caixa), limpar = $(".limpar", caixa);
  const opcoes = [];
  async function buscar() {
    const q = input.value.trim();
    limpar.classList.toggle("oculto", !q);
    if (q.length < 1) { lista.classList.add("oculto"); return; }
    let linhas = [];
    try { linhas = await pedir("/api/linhas", { q }); } catch { /* mostra só o destino */ }
    if (input.value.trim() !== q) return;
    opcoes.length = 0;
    for (const l of linhas.slice(0, 8)) opcoes.push({ tipo: "linha", l });
    const pareceLinha = /^\d[\d.,]*$/.test(q);
    if (q.length >= 3 && !(pareceLinha && linhas.length)) opcoes.push({ tipo: "destino", q });
    if (q.length >= 3 && !pareceLinha && !estado.pos) opcoes.push({ tipo: "posicao", q });
    lista.innerHTML = html(h`${opcoes.map((o, i) => o.tipo === "linha"
      ? h`<button class="sugestao" role="option" data-i="${i}">${chipLinha(o.l.numero, o.l.cor, o.l.cor_texto)}<span class="nome">${o.l.nome}</span></button>`
      : h`<button class="sugestao" role="option" data-i="${i}"><span class="icone-lugar">${o.tipo === "destino" ? ICONE.rota : ICONE.pino}</span>
          <span class="nome"><b style="color:var(--texto)">${o.tipo === "destino" ? "Como chegar em" : "Estou em"}</b> “${o.q}”</span></button>`)}
      ${!opcoes.length ? h`<p class="sub" style="padding:10px">Nenhuma linha com “${q}”.</p>` : ""}`);
    lista.classList.remove("oculto");
  }
  function escolher(o) {
    if (!o) return;
    input.value = "";
    limpar.classList.add("oculto");
    fecharSugestoes();
    input.blur();
    if (o.tipo === "linha") abrirLinha(o.l.id);
    else if (o.tipo === "destino") abrirRota(o.q);
    else pedir("/api/endereco", { q: o.q }).then((e) => definirPosicao(e.lat, e.lon, e.rotulo.split(",")[0])).catch((e) => avisar(e.message));
  }
  input.addEventListener("input", () => { clearTimeout(tempoBusca); tempoBusca = setTimeout(buscar, 220); });
  input.addEventListener("focus", () => { if (input.value.trim()) buscar(); });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") { fecharSugestoes(); input.blur(); }
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(tempoBusca);
    await buscar();
    escolher(opcoes[0]);
  });
  lista.addEventListener("click", (e) => { const b = e.target.closest(".sugestao"); if (b) escolher(opcoes[+b.dataset.i]); });
  limpar.addEventListener("click", () => { input.value = ""; limpar.classList.add("oculto"); fecharSugestoes(); input.focus(); });
}

// ================================================================ início
render();
iniciarGeo();
if (!nativo && "serviceWorker" in navigator && isSecureContext) {
  let recarregando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (recarregando) return;
    recarregando = true;
    location.reload();
  });
  navigator.serviceWorker.register("/sw.js").then((registro) => registro.update()).catch(() => {});
}

// Botão "voltar" do Android: volta uma tela; no início, sai do app.
window.Capacitor?.Plugins?.App?.addListener("backButton", () => {
  if (estado.vista === "inicio") window.Capacitor.Plugins.App.exitApp();
  else $('[data-acao="voltar"]', conteudo)?.click();
});
