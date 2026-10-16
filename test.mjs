import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));

async function portaLivre() {
  const temporario = createServer();
  temporario.listen(0, "127.0.0.1");
  await once(temporario, "listening");
  const { port } = temporario.address();
  await new Promise((resolve, reject) => temporario.close((erro) => erro ? reject(erro) : resolve()));
  return port;
}

async function fetchComPrazo(url, opcoes = {}, prazoMs = 20_000) {
  const controle = new AbortController();
  const temporizador = setTimeout(() => controle.abort(), prazoMs);
  try {
    return await fetch(url, { ...opcoes, signal: controle.signal });
  } finally {
    clearTimeout(temporizador);
  }
}

async function esperarServidor(base, processo, saida) {
  const limite = Date.now() + 12_000;
  while (Date.now() < limite) {
    if (processo.exitCode !== null) throw new Error(`Servidor encerrou antes do teste.\n${saida()}`);
    try {
      const resposta = await fetchComPrazo(`${base}/healthz`, {}, 1_000);
      if (resposta.ok) return;
    } catch {
      // O processo ainda pode estar inicializando.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Servidor não ficou pronto em 12 segundos.\n${saida()}`);
}

test("Busão DF: módulos e integração HTTP", { timeout: 60_000 }, async (t) => {
  await t.test("todos os módulos JavaScript têm sintaxe válida", () => {
    for (const arquivo of [
      "server.mjs",
      "sw.js",
      "js/app.js",
      "js/dados.js",
      "js/folha.js",
      "js/mapa.js",
      "js/movimento.js",
      "js/motor.js",
    ]) {
      execFileSync(process.execPath, ["--check", path.join(RAIZ, arquivo)], { stdio: "pipe" });
    }
  });

  await t.test("motor exporta a interface esperada", async () => {
    const motor = await import("./js/motor.js");
    assert.equal(typeof motor.atender, "function");
    assert.equal(typeof motor.ErroUsuario, "function");
    assert.equal(typeof motor.INTERVALO_S, "number");
    assert.equal(typeof motor.metadadosConforto, "function");
    assert.equal(typeof motor.tipoIntegracao, "function");
    assert.equal(typeof motor.imagemParada, "function");
    assert.equal(typeof motor.infraestruturaParada, "function");
  });

  await t.test("imagem da parada usa fallback de satélite sem chave", async () => {
    const motor = await import("./js/motor.js");
    const anterior = motor.buscarHttp;
    motor.usarHttp(async () => ({ ok: true, json: async () => ({ query: { pages: {} } }) }));
    try {
      const imagem = await motor.imagemParada(-15.7939, -47.8828);
      assert.equal(imagem.tipo, "satelite");
      assert.match(imagem.url, /World_Imagery/);
      assert.match(imagem.url, /bbox=/);
    } finally { motor.usarHttp(anterior); }
  });

  await t.test("infraestrutura reconhece terminais sem depender da rede", async () => {
    const { infraestruturaParada } = await import("./js/motor.js");
    const estrutura = await infraestruturaParada("Terminal Rodoviário do Plano Piloto", -15.7939, -47.8828);
    assert.equal(estrutura.tipo, "integracao");
    assert.match(estrutura.rotulo, /Terminal|Integração/);
  });

  await t.test("normaliza acessibilidade, ar-condicionado e integrações", async () => {
    const { metadadosConforto, tipoIntegracao } = await import("./js/motor.js");
    assert.deepEqual(metadadosConforto({ wa: true, ac: true }), { acessivel: true, ar_condicionado: true });
    assert.deepEqual(metadadosConforto({ wheelchair_accessible: 1, airConditioned: "yes" }),
      { acessivel: true, ar_condicionado: true });
    assert.deepEqual(metadadosConforto({ features: ["rampa", "ar-condicionado"] }),
      { acessivel: true, ar_condicionado: true });
    assert.deepEqual(tipoIntegracao("Estação Central do Metrô"), { tipo: "metro", rotulo: "Metrô-DF" });
    assert.deepEqual(tipoIntegracao("Terminal BRT Santa Maria"), { tipo: "brt", rotulo: "BRT" });
    assert.equal(tipoIntegracao("Parada QN 12"), null);
  });

  await t.test("filtro de movimento rejeita salto impossível de GPS", async () => {
    const { movimentoPlausivel, limiteDeslocamento, confirmaNovaArea } = await import("./js/movimento.js");
    assert.equal(movimentoPlausivel(250, 15, 15_000), true);
    assert.equal(movimentoPlausivel(1_500, 15, 15_000), false);
    assert.ok(limiteDeslocamento(15, 15_000) < 500);
    const distancia = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    assert.equal(confirmaNovaArea([100, 100], [110, 105], distancia, 20), true);
    assert.equal(confirmaNovaArea([100, 100], [300, 300], distancia, 20), false);
  });

  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const processo = spawn(process.execPath, ["server.mjs"], {
    cwd: RAIZ,
    env: { ...process.env, PORT: String(porta), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  processo.stdout.on("data", (trecho) => { logs += trecho; });
  processo.stderr.on("data", (trecho) => { logs += trecho; });

  try {
    await esperarServidor(base, processo, () => logs);

    await t.test("GET /healthz retorna status e uptime", async () => {
      const resposta = await fetchComPrazo(`${base}/healthz`);
      assert.equal(resposta.status, 200);
      assert.match(resposta.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(resposta.headers.get("cache-control"), "no-store");
      const corpo = await resposta.json();
      assert.equal(corpo.status, "ok");
      assert.equal(typeof corpo.uptime, "number");
      assert.ok(corpo.uptime >= 0);
    });

    await t.test("GET /api/linhas consulta a integração Mobilibus", async (subteste) => {
      if (process.env.SKIP_LIVE_API === "1") {
        subteste.skip("Consulta externa desativada por SKIP_LIVE_API=1");
        return;
      }
      const resposta = await fetchComPrazo(`${base}/api/linhas?q=0.809`, {}, 30_000);
      const corpo = await resposta.json();
      assert.equal(resposta.status, 200, corpo.detail ?? "Resposta inesperada da API");
      assert.ok(Array.isArray(corpo));
      assert.ok(corpo.length > 0, "A Mobilibus não retornou nenhuma linha para 0.809");
      assert.equal(corpo[0].numero, "0.809");
      assert.equal(typeof corpo[0].acessivel, "boolean");
      assert.equal(typeof corpo[0].ar_condicionado, "boolean");
    });

    await t.test("GET /api/ao-vivo inicia um stream SSE", async () => {
      const controle = new AbortController();
      const temporizador = setTimeout(() => controle.abort(), 10_000);
      try {
        const resposta = await fetch(`${base}/api/ao-vivo`, { signal: controle.signal });
        assert.equal(resposta.status, 200);
        assert.match(resposta.headers.get("content-type") ?? "", /^text\/event-stream/);
        const leitor = resposta.body.getReader();
        const decoder = new TextDecoder();
        let recebido = "";
        while (!recebido.includes("event: dados")) {
          const { done, value } = await leitor.read();
          if (done) break;
          recebido += decoder.decode(value, { stream: true });
        }
        assert.match(recebido, /retry: 5000/);
        assert.match(recebido, /event: config/);
        assert.match(recebido, /event: dados/);
        await leitor.cancel();
      } finally {
        clearTimeout(temporizador);
        controle.abort();
      }
    });
  } finally {
    if (processo.exitCode === null) processo.kill("SIGTERM");
    if (processo.exitCode === null) {
      await Promise.race([
        once(processo, "exit"),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
  }
});
