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
