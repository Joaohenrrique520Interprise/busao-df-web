// Mapa (MapLibre + OpenFreeMap): ônibus desenhados pelo próprio mapa (acompanham zoom e arrasto),
// andando pela rua entre uma leitura e outra; paradas, trajeto da linha e "eu".
/* global maplibregl */

import { confirmaNovaArea, limiteDeslocamento, movimentoPlausivel } from "./movimento.js?v=7";

const ESTILOS = {
  claro: "https://tiles.openfreemap.org/styles/liberty",
  escuro: "https://tiles.openfreemap.org/styles/dark",
};
const PLANO_PILOTO = [-47.8828, -15.7939];
const reduzMovimento = matchMedia("(prefers-reduced-motion: reduce)").matches;
const vazio = () => ({ type: "FeatureCollection", features: [] });
const COR_STATUS = { no_horario: "#16a34a", atrasado: "#ea7a0c", adiantado: "#2563eb", gps_velho: "#8b939e" };
const PROPORCAO = 2;      // imagens desenhadas em 2x para ficarem nítidas

// ---------------------------------------------------------------- desenho dos ícones (canvas, síncrono)
const tela = (w, hgt) => (typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, hgt)
  : Object.assign(document.createElement("canvas"), { width: w, height: hgt }));
function onibusImagem(cor) {
  // Ônibus visto de cima, frente para o norte (o mapa gira pelo rumo).
  const w = 26 * PROPORCAO, hgt = 52 * PROPORCAO, k = PROPORCAO;
  const c = tela(w, hgt), g = c.getContext("2d");
  g.scale(k, k);
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 3; g.shadowOffsetY = 1;
  g.fillStyle = cor; g.strokeStyle = "#fff"; g.lineWidth = 2;
  g.beginPath(); g.roundRect(4, 3, 18, 46, 5); g.fill(); g.stroke();
  g.shadowColor = "transparent";
  g.fillStyle = "#1b2430";                                    // espelhos
  g.fillRect(1.5, 7, 3, 4); g.fillRect(21.5, 7, 3, 4);
  g.fillStyle = "rgba(15,29,46,.92)";                         // para-brisa
  g.beginPath(); g.roundRect(6.5, 5.5, 13, 8, 2.5); g.fill();
  g.fillStyle = "rgba(255,255,255,.55)";                      // ar-condicionado no teto
  g.beginPath(); g.roundRect(8, 20, 10, 11, 2); g.fill();
  g.fillStyle = "rgba(255,255,255,.28)";                      // faixas do teto
  g.fillRect(8, 34, 10, 2); g.fillRect(8, 38, 10, 2);
  g.fillStyle = "rgba(15,29,46,.75)";                         // vidro traseiro
  g.beginPath(); g.roundRect(7.5, 43, 11, 3.5, 1.5); g.fill();
  return g.getImageData(0, 0, w, hgt);
}

function paradaImagem() {
  const s = 22 * PROPORCAO, c = tela(s, s), g = c.getContext("2d");
  g.scale(PROPORCAO, PROPORCAO);
  g.shadowColor = "rgba(0,0,0,.3)"; g.shadowBlur = 2; g.shadowOffsetY = 1;
  g.fillStyle = "#0f1d2e"; g.strokeStyle = "#fff"; g.lineWidth = 2;
  g.beginPath(); g.roundRect(2, 2, 18, 18, 5); g.fill(); g.stroke();
  g.shadowColor = "transparent";
  g.fillStyle = "#f2a516";                                    // ônibus de frente, pictograma
  g.beginPath(); g.roundRect(6.5, 5.5, 9, 9.5, 2); g.fill();
  g.fillStyle = "#0f1d2e"; g.fillRect(7.8, 7, 6.4, 3.4);
  g.fillStyle = "#f2a516"; g.fillRect(7.5, 15, 2, 2); g.fillRect(12.5, 15, 2, 2);
  return g.getImageData(0, 0, s, s);
}

// ---------------------------------------------------------------- caminho percorrido
const metrosEntre = ([o1, a1], [o2, a2]) => {
  const x = (o2 - o1) * 111320 * Math.cos((a1 * Math.PI) / 180), y = (a2 - a1) * 110540;
  return Math.hypot(x, y);
};
const rumoEntre = ([o1, a1], [o2, a2]) =>
  ((Math.atan2((o2 - o1) * Math.cos((a1 * Math.PI) / 180), a2 - a1) * 180) / Math.PI + 360) % 360;

function caminho(pontos) {
  const acc = [0];
  for (let i = 1; i < pontos.length; i++) acc.push(acc[i - 1] + metrosEntre(pontos[i - 1], pontos[i]));
  return { pontos, acc, total: acc[acc.length - 1] };
}

function pontoNoCaminho(cam, fracao) {
  if (cam.total === 0 || cam.pontos.length < 2) return { pos: cam.pontos[cam.pontos.length - 1], rumo: null };
  const d = cam.total * fracao;
  let i = 1;
  while (i < cam.acc.length - 1 && cam.acc[i] < d) i++;
  const a = cam.pontos[i - 1], b = cam.pontos[i];
  const seg = cam.acc[i] - cam.acc[i - 1], t = seg ? (d - cam.acc[i - 1]) / seg : 1;
  return { pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], rumo: seg ? rumoEntre(a, b) : null };
}

// ================================================================ mapa
export class Mapa {
  constructor(el, tema, { aoClicarOnibus, aoClicarParada }) {
    this.aoClicarOnibus = aoClicarOnibus;
    this.aoClicarParada = aoClicarParada;
    this.tema = tema;
    this.onibus = new Map();       // id -> {v, cam, t0, dur, pos, rumo}
    this.destaque = null;
    this.duracaoMs = 13000;
    this.dados = { paradas: vazio(), trajeto: vazio(), onibus: vazio() };
    this.mapa = new maplibregl.Map({
      container: el, style: ESTILOS[tema], center: PLANO_PILOTO, zoom: 11.5,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
    });
    this.mapa.touchZoomRotate.disableRotation();
    this.mapa.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    this.mapa.on("style.load", () => this._camadas());
    this.mapa.on("styleimagemissing", (e) => this._imagem(e.id));

    for (const camada of ["onibus", "onibus-rotulo"]) {
      this.mapa.on("click", camada, (e) => {
        const o = this.onibus.get(e.features[0]?.properties.id);
        if (o) this.aoClicarOnibus(o.v);
      });
      this._cursor(camada);
    }
    this.mapa.on("click", "paradas", (e) => {
      const f = e.features[0];
      if (f) this.aoClicarParada({ id: f.properties.id, nome: f.properties.nome, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
    });
    this._cursor("paradas");
  }

  _cursor(camada) {
    this.mapa.on("mouseenter", camada, () => { this.mapa.getCanvas().style.cursor = "pointer"; });
    this.mapa.on("mouseleave", camada, () => { this.mapa.getCanvas().style.cursor = ""; });
  }

  _imagem(id) {
    if (this.mapa.hasImage(id)) return;
    if (id === "parada") this.mapa.addImage(id, paradaImagem(), { pixelRatio: PROPORCAO });
    else if (id.startsWith("onibus-")) this.mapa.addImage(id, onibusImagem(COR_STATUS[id.slice(7)] ?? "#16a34a"), { pixelRatio: PROPORCAO });
    else {
      // Alguns estilos externos referenciam POIs que não existem no sprite atual.
      // Um pixel transparente evita avisos repetidos sem interferir no mapa.
      this.mapa.addImage(id, { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) });
    }
  }

  definirTema(tema) { this.tema = tema; this.mapa.setStyle(ESTILOS[tema]); }   // as camadas voltam no "style.load"

  _camadas() {
    const m = this.mapa;
    const escuro = this.tema === "escuro";
    // O trajeto vai por baixo dos nomes de rua; ônibus e paradas por cima de tudo.
    const primeiroRotulo = m.getStyle().layers.find((l) => l.type === "symbol")?.id;
    for (const fonte of ["trajeto", "paradas", "onibus"]) m.addSource(fonte, { type: "geojson", data: this.dados[fonte] });

    m.addLayer({ id: "trajeto-borda", type: "line", source: "trajeto", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 16, 15], "line-opacity": escuro ? 0.3 : 0.95 } }, primeiroRotulo);
    m.addLayer({ id: "trajeto", type: "line", source: "trajeto", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["get", "cor"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 8] } }, primeiroRotulo);

    m.addLayer({ id: "paradas", type: "symbol", source: "paradas", minzoom: 13.5,
      layout: { "icon-image": "parada", "icon-size": ["interpolate", ["linear"], ["zoom"], 13.5, 0.6, 17, 1],
        "icon-allow-overlap": true, "icon-ignore-placement": true } });

    m.addLayer({ id: "onibus-pulso", type: "circle", source: "onibus", filter: ["==", ["get", "destaque"], true],
      paint: { "circle-radius": 18, "circle-color": ["get", "cor"], "circle-opacity": 0.3, "circle-pitch-alignment": "map" } });
    m.addLayer({ id: "onibus", type: "symbol", source: "onibus",
      layout: {
        "icon-image": ["concat", "onibus-", ["get", "status"]],
        "icon-rotate": ["get", "rumo"], "icon-rotation-alignment": "map",
        "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 13, 0.75, 15, 1.05, 18, 1.5],
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "symbol-sort-key": ["case", ["get", "destaque"], 1, 0],
      } });
    m.addLayer({ id: "onibus-rotulo", type: "symbol", source: "onibus", minzoom: 12,
      layout: {
        "text-field": ["get", "linha"], "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 13],
        "text-variable-anchor": ["left", "right", "top", "bottom"], "text-radial-offset": 1.3,
        "text-allow-overlap": false, "symbol-sort-key": ["case", ["get", "destaque"], 0, 1],
      },
      paint: { "text-color": escuro ? "#ffffff" : "#14181f", "text-halo-color": escuro ? "#0b1017" : "#ffffff", "text-halo-width": 2 } });
    this._pintarOnibus();
  }

  _fonte(nome, dados) {
    this.dados[nome] = dados;
    this.mapa.getSource(nome)?.setData(dados);
  }

  // ---------------------------------------------------------------- eu e minha parada (marcadores HTML simples)
  eu(pos) {
    if (!pos) { this.marcadorEu?.remove(); this.marcadorEu = null; return; }
    if (!this.marcadorEu) {
      const el = document.createElement("div");
      el.className = "eu";
      el.setAttribute("aria-label", "Você está aqui");
      this.marcadorEu = new maplibregl.Marker({ element: el }).setLngLat([pos.lon, pos.lat]).addTo(this.mapa);
    }
    this.marcadorEu.getElement().classList.toggle("endereco", pos.origem !== "gps");
    this.marcadorEu.setLngLat([pos.lon, pos.lat]);
  }

  minhaParada(p) {
    this.marcadorParada?.remove();
    this.marcadorParada = null;
    if (!p) return;
    const el = document.createElement("div");
    el.className = "pino-parada";
    el.innerHTML = `<svg width="34" height="42" viewBox="0 0 34 42" aria-hidden="true"><path d="M17 41s14-12.2 14-23.5C31 8.4 24.7 2 17 2S3 8.4 3 17.5C3 28.8 17 41 17 41z" fill="#f2a516" stroke="#fff" stroke-width="3"/><rect x="11" y="10" width="12" height="11" rx="2.5" fill="#1b1300"/><path d="M11 16h12" stroke="#f2a516" stroke-width="1.5"/></svg>`;
    el.setAttribute("aria-label", `Sua parada: ${p.nome}`);
    this.marcadorParada = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([p.lon, p.lat]).addTo(this.mapa);
  }

  aoMover(cb) { this.mapa.on("moveend", cb); }

  /** Centro, raio (até o canto da tela, em metros) e zoom da área visível. */
  area() {
    const c = this.mapa.getCenter(), canto = this.mapa.getBounds().getNorthEast();
    return { lat: c.lat, lon: c.lng, raio: Math.round(metrosEntre([c.lng, c.lat], [canto.lng, canto.lat])), zoom: this.mapa.getZoom() };
  }

  centralizar(pos, zoom = 15) { this.mapa.easeTo({ center: [pos.lon, pos.lat], zoom, duration: reduzMovimento ? 0 : 900 }); }

  enquadrar(coords) {
    if (!coords.length) return;
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    this.mapa.fitBounds(b, { padding: 50, maxZoom: 16, duration: reduzMovimento ? 0 : 900 });
  }

  // ---------------------------------------------------------------- paradas e trajeto
  paradas(lista) {
    this._fonte("paradas", { type: "FeatureCollection", features: lista.map((p) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { id: p.id, nome: p.nome },
    })) });
  }

  trajeto(coords, cor) {
    this._fonte("trajeto", coords ? { type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: { cor } }] } : vazio());
  }

  // ---------------------------------------------------------------- ônibus
  /** Recebe a leitura nova. Filtra saltos de GPS e anima apenas deslocamentos fisicamente plausíveis. */
  veiculos(lista, destaque = null, intervaloS = 15) {
    const agora = performance.now();
    this.destaque = destaque;
    this.duracaoMs = Math.max(2000, intervaloS * 1000 * 0.9);   // anda o intervalo quase todo: movimento contínuo
    const vistos = new Set();
    for (const v of lista) {
      vistos.add(v.id);
      const novo = [v.lon, v.lat];
      const o = this.onibus.get(v.id);
      if (!o || reduzMovimento) {
        this.onibus.set(v.id, { v, cam: caminho([novo]), t0: agora, pos: novo, rumo: v.rumo,
          ultimaLeituraMs: agora, saltoPendente: null });
        continue;
      }

      const distanciaDireta = metrosEntre(o.pos, novo);
      const tempoDesdeLeituraMs = agora - (o.ultimaLeituraMs ?? agora);
      const limiteM = limiteDeslocamento(intervaloS, tempoDesdeLeituraMs);

      if (!movimentoPlausivel(distanciaDireta, intervaloS, tempoDesdeLeituraMs)) {
        if (!confirmaNovaArea(o.saltoPendente, novo, metrosEntre)) {
          // Primeira leitura impossível: segura o ônibus onde está. Se a próxima leitura voltar,
          // o usuário nunca vê a ida e volta causada pelo ponto de GPS incorreto.
          Object.assign(o, { v, cam: caminho([o.pos]), t0: agora, ultimaLeituraMs: agora, saltoPendente: novo });
          continue;
        }

        // Duas leituras consecutivas confirmaram a nova área. Reposiciona sem simular centenas
        // de km/h; isso também cobre um veículo que reapareceu depois de ficar sem sinal.
        Object.assign(o, { v, cam: caminho([novo]), t0: agora, pos: novo, rumo: v.rumo,
          ultimaLeituraMs: agora, saltoPendente: null });
        continue;
      }

      const trilha = v.trilha?.length > 1 ? v.trilha : [novo];
      let pontos;
      if (trilha.length > 1 && metrosEntre(o.pos, trilha[0]) < 80) pontos = [o.pos, ...trilha];   // segue a rua
      else pontos = [o.pos, novo];

      // Um encaixe ruim no traçado pode montar uma volta enorme mesmo com início e fim próximos.
      // Nesse caso, a linha reta curta é visualmente mais fiel do que acelerar pela rota inteira.
      if (caminho(pontos).total > limiteM * 1.15) pontos = [o.pos, novo];
      Object.assign(o, { v, cam: caminho(pontos), t0: agora, ultimaLeituraMs: agora, saltoPendente: null });
    }
    for (const id of [...this.onibus.keys()]) if (!vistos.has(id)) this.onibus.delete(id);
    this._animar();
  }

  _animar() {
    if (this.animando) return;
    this.animando = true;
    const quadro = (t) => {
      let falta = false;
      for (const o of this.onibus.values()) {
        const k = Math.min((t - o.t0) / this.duracaoMs, 1);
        const { pos, rumo } = pontoNoCaminho(o.cam, k);
        o.pos = pos;
        if (rumo != null && o.cam.total > 3) o.rumo = rumo; else if (k >= 1) o.rumo = o.v.rumo;
        if (k < 1) falta = true;
      }
      this._pintarOnibus(t);
      if (falta || this.destaque) requestAnimationFrame(quadro); else this.animando = false;
    };
    requestAnimationFrame(quadro);
  }

  _pintarOnibus(t = performance.now()) {
    this._fonte("onibus", { type: "FeatureCollection", features: [...this.onibus.values()].map((o) => ({
      type: "Feature", geometry: { type: "Point", coordinates: o.pos },
      properties: { id: o.v.id, linha: o.v.linha, status: o.v.status, cor: COR_STATUS[o.v.status], rumo: o.rumo, destaque: o.v.id === this.destaque },
    })) });
    if (this.destaque && this.mapa.getLayer("onibus-pulso") && !reduzMovimento) {
      const fase = (t % 1800) / 1800;                         // pulso do ônibus que chega primeiro
      this.mapa.setPaintProperty("onibus-pulso", "circle-radius", 14 + fase * 22);
      this.mapa.setPaintProperty("onibus-pulso", "circle-opacity", 0.4 * (1 - fase));
    }
  }
}
