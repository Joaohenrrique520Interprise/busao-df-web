// Painel inferior arrastável (só no celular; no desktop vira painel lateral via CSS).

const desktop = matchMedia("(min-width: 900px)");

/** Abre a imagem da parada sem tirar o passageiro do contexto atual. */
export function abrirImagemTelaCheia(src, alt, legenda = "") {
  const dialogo = document.createElement("dialog");
  dialogo.className = "foto-modal";
  dialogo.setAttribute("aria-label", alt);
  const botao = document.createElement("button"), figura = document.createElement("figure");
  const imagem = document.createElement("img"), descricao = document.createElement("figcaption");
  botao.type = "button"; botao.className = "foto-fechar"; botao.setAttribute("aria-label", "Fechar imagem"); botao.textContent = "✕";
  imagem.src = src; imagem.alt = alt; descricao.textContent = legenda;
  figura.append(imagem, descricao); dialogo.append(botao, figura);
  const fechar = () => dialogo.close();
  botao.addEventListener("click", fechar);
  dialogo.addEventListener("click", (e) => { if (e.target === dialogo) fechar(); });
  dialogo.addEventListener("close", () => dialogo.remove(), { once: true });
  document.body.append(dialogo);
  dialogo.showModal();
}

export class Folha {
  constructor(el, aoMudar) {
    this.el = el;
    this.aoMudar = aoMudar;
    this.posicao = "meio";
    const alca = el.querySelector(".alca");
    let inicioY = 0, inicioVisivel = 0, moveu = false;

    alca.addEventListener("pointerdown", (e) => {
      if (desktop.matches) return;
      alca.setPointerCapture(e.pointerId);
      inicioY = e.clientY;
      inicioVisivel = this.visivel();
      moveu = false;
      el.classList.add("arrastando");
    });
    alca.addEventListener("pointermove", (e) => {
      if (!el.classList.contains("arrastando")) return;
      const dy = inicioY - e.clientY;
      if (Math.abs(dy) > 4) moveu = true;
      this._aplicar(Math.min(Math.max(inicioVisivel + dy, this._alturas().baixo), this._alturas().alto));
    });
    const soltar = (e) => {
      if (!el.classList.contains("arrastando")) return;
      el.classList.remove("arrastando");
      if (!moveu) { this.ir(this.posicao === "alto" ? "meio" : "alto"); return; }   // toque alterna
      const atual = inicioVisivel + (inicioY - e.clientY);
      const alturas = this._alturas();
      const maisPerto = Object.entries(alturas).sort((a, b) => Math.abs(a[1] - atual) - Math.abs(b[1] - atual))[0][0];
      this.ir(maisPerto);
    };
    alca.addEventListener("pointerup", soltar);
    alca.addEventListener("pointercancel", soltar);
    addEventListener("resize", () => this.ir(this.posicao));
    desktop.addEventListener("change", () => this.ir(this.posicao));
    this.ir("meio");
  }

  _alturas() {
    const h = innerHeight;
    return { baixo: 172, meio: Math.round(h * 0.5), alto: Math.round(h * 0.92) };
  }

  visivel() { return desktop.matches ? 0 : this._alturas()[this.posicao]; }

  _aplicar(px) { document.documentElement.style.setProperty("--folha-visivel", `${px}px`); }

  ir(posicao) {
    this.posicao = posicao;
    this._aplicar(this.visivel());
    this.aoMudar?.({ desktop: desktop.matches, visivel: this.visivel() });
  }
}
