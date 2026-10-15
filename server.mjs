import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { atender, ErroUsuario, INTERVALO_S } from "./js/motor.js";

const HOST = "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 15_000;
const PRAZO_ENCERRAMENTO_MS = 10_000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`PORT inválida: ${process.env.PORT ?? ""}`);
}

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".map", "application/json; charset=utf-8"],
]);

const ARQUIVOS_RAIZ = new Set(["/index.html", "/estilo.css", "/manifest.webmanifest", "/sw.js"]);
const PASTAS_PUBLICAS = ["/icones/", "/js/", "/vendor/"];
const sockets = new Set();
const sessoesSse = new Set();
let encerrando = false;

function cabecalhosComuns() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self)",
  };
}

function cabecalhosApi() {
  return {
    ...cabecalhosComuns(),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Last-Event-ID",
    "Cache-Control": "no-store",
  };
}

function responderJson(req, res, status, corpo, extras = {}) {
  const conteudo = JSON.stringify(corpo);
  res.writeHead(status, {
    ...cabecalhosApi(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(conteudo),
    ...extras,
  });
  res.end(req.method === "HEAD" ? undefined : conteudo);
}

function paramsDa(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function statusDoErro(erro) {
  if (!(erro instanceof ErroUsuario)) return 500;
  if (erro.message === "Rota desconhecida.") return 404;
  if (erro.message.includes("não respondeu")) return 502;
  return 400;
}

function detalheSeguro(erro) {
  return erro instanceof ErroUsuario ? erro.message : "Erro interno do servidor.";
}

async function apiJson(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cabecalhosApi());
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    responderJson(req, res, 405, { detail: "Método não permitido." }, { Allow: "GET, HEAD, OPTIONS" });
    return;
  }

  try {
    const corpo = await atender(url.pathname, paramsDa(url));
    responderJson(req, res, 200, corpo);
  } catch (erro) {
    if (erro instanceof ErroUsuario) console.warn(`[api] ${url.pathname}: ${erro.message}`);
    else console.error(`[api] ${url.pathname}:`, erro);
    responderJson(req, res, statusDoErro(erro), { detail: detalheSeguro(erro) });
  }
}

function enviarEvento(res, evento, dados) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function apiAoVivo(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cabecalhosApi());
    res.end();
    return;
  }
  if (req.method !== "GET") {
    responderJson(req, res, 405, { detail: "Método não permitido." }, { Allow: "GET, OPTIONS" });
    return;
  }

  res.writeHead(200, {
    ...cabecalhosApi(),
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  enviarEvento(res, "config", { intervalo_s: INTERVALO_S });

  const params = paramsDa(url);
  let fechado = false;
  let temporizadorDados = null;
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const sessao = {
    res,
    fechar(encerrarResposta = false) {
      if (fechado) return;
      fechado = true;
      clearTimeout(temporizadorDados);
      clearInterval(heartbeat);
      sessoesSse.delete(sessao);
      if (encerrarResposta && !res.destroyed && !res.writableEnded) res.end();
    },
  };
  sessoesSse.add(sessao);

  req.on("close", () => sessao.fechar());
  res.on("close", () => sessao.fechar());

  const atualizar = async () => {
    try {
      const dados = await atender("/api/agora", params);
      if (!fechado) enviarEvento(res, "dados", dados);
    } catch (erro) {
      if (!(erro instanceof ErroUsuario)) console.error("[sse] /api/ao-vivo:", erro);
      if (!fechado) enviarEvento(res, "erro", { detail: detalheSeguro(erro) });
    } finally {
      if (!fechado) temporizadorDados = setTimeout(atualizar, INTERVALO_S * 1000);
    }
  };

  atualizar();
}

function caminhoEstatico(pathname) {
  let publico;
  try {
    publico = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    return null;
  }
  if (publico.includes("\0") || publico.includes("\\")) return null;
  if (!ARQUIVOS_RAIZ.has(publico) && !PASTAS_PUBLICAS.some((p) => publico.startsWith(p))) return null;

  const absoluto = path.resolve(RAIZ, publico.slice(1));
  const relativo = path.relative(RAIZ, absoluto);
  if (relativo.startsWith("..") || path.isAbsolute(relativo)) return null;
  return absoluto;
}

function cacheEstatico(url) {
  if (["/", "/index.html", "/sw.js", "/manifest.webmanifest"].includes(url.pathname)) return "no-cache";
  const temHash = /\.[a-f0-9]{8,}\./i.test(url.pathname);
  if (temHash || url.searchParams.has("v")) return "public, max-age=31536000, immutable";
  if (url.pathname.startsWith("/icones/")) return "public, max-age=86400, stale-while-revalidate=604800";
  return "no-cache";
}

async function estatico(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    responderJson(req, res, 405, { detail: "Método não permitido." }, { Allow: "GET, HEAD" });
    return;
  }

  const arquivo = caminhoEstatico(url.pathname);
  if (!arquivo) {
    responderJson(req, res, 404, { detail: "Arquivo não encontrado." });
    return;
  }

  try {
    const info = await stat(arquivo);
    if (!info.isFile()) throw new Error("não é arquivo");

    const etag = `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`;
    const base = {
      ...cabecalhosComuns(),
      "Content-Type": MIME.get(path.extname(arquivo).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": cacheEstatico(url),
      "Last-Modified": info.mtime.toUTCString(),
      ETag: etag,
    };
    if (url.pathname === "/sw.js") base["Service-Worker-Allowed"] = "/";

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, base);
      res.end();
      return;
    }

    res.writeHead(200, base);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const fluxo = createReadStream(arquivo);
    fluxo.on("error", () => res.destroy());
    fluxo.pipe(res);
  } catch {
    if (!res.headersSent) responderJson(req, res, 404, { detail: "Arquivo não encontrado." });
    else res.end();
  }
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (encerrando) {
      responderJson(req, res, 503, { detail: "Servidor encerrando." }, { Connection: "close" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      responderJson(req, res, 200, { status: "ok", uptime: process.uptime() });
    } else if (url.pathname === "/api/ao-vivo") {
      apiAoVivo(req, res, url);
    } else if (url.pathname.startsWith("/api/")) {
      await apiJson(req, res, url);
    } else {
      await estatico(req, res, url);
    }
  } catch (erro) {
    console.error("[http]", erro);
    if (!res.headersSent) responderJson(req, res, 500, { detail: "Erro interno do servidor." });
    else res.end();
  }
});

servidor.requestTimeout = 30_000;
servidor.headersTimeout = 35_000;
servidor.keepAliveTimeout = 5_000;

servidor.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

servidor.on("clientError", (_erro, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

function ipsLocais() {
  const ips = new Set();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces ?? []) {
      if (item.family === "IPv4" && !item.internal) ips.add(item.address);
    }
  }
  return [...ips];
}

servidor.listen(PORT, HOST, () => {
  console.log("\nBusão DF iniciado com sucesso.");
  console.log(`Neste computador: http://localhost:${PORT}`);
  for (const ip of ipsLocais()) console.log(`Na rede local:   http://${ip}:${PORT}`);
  console.log("\nPressione Ctrl+C para encerrar.\n");
});

function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n${sinal} recebido; encerrando com segurança...`);

  for (const sessao of [...sessoesSse]) {
    enviarEvento(sessao.res, "encerrando", { detail: "Servidor reiniciando." });
    sessao.fechar(true);
  }

  servidor.close(() => process.exit(0));
  const limite = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    process.exit(1);
  }, PRAZO_ENCERRAMENTO_MS);
  limite.unref();
}

process.on("SIGINT", () => encerrar("SIGINT"));
process.on("SIGTERM", () => encerrar("SIGTERM"));
