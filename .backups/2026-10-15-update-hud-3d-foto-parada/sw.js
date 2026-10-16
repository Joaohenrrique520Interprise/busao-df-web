// App Shell offline. Localização e respostas /api/* nunca entram no cache.
const PREFIXO_CACHE = "busao-web-";
const VERSAO = `${PREFIXO_CACHE}v8`;
const CASCA = [
  "/",
  "/index.html",
  "/estilo.css?v=8",
  "/js/app.js?v=8",
  "/js/dados.js",
  "/js/mapa.js?v=8",
  "/js/movimento.js?v=7",
  "/js/folha.js",
  "/vendor/maplibre-gl.js?v=6",
  "/vendor/maplibre-gl.css?v=6",
  "/manifest.webmanifest",
  "/icones/icone.svg",
  "/icones/icone-192.png",
  "/icones/icone-512.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(VERSAO)
      .then((cache) => cache.addAll(CASCA))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(
        chaves.filter((chave) => chave.startsWith(PREFIXO_CACHE) && chave !== VERSAO)
          .map((chave) => caches.delete(chave)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (evento) => {
  const url = new URL(evento.request.url);
  if (evento.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  const chave = `${url.pathname}${url.search}`;
  if (!CASCA.includes(chave)) return;

  evento.respondWith((async () => {
    try {
      const resposta = await fetch(evento.request, { cache: "no-cache" });
      if (resposta.ok) {
        const cache = await caches.open(VERSAO);
        await cache.put(evento.request, resposta.clone());
      }
      return resposta;
    } catch {
      const guardada = await caches.match(evento.request);
      if (guardada) return guardada;
      if (evento.request.mode === "navigate") {
        const inicio = await caches.match("/");
        if (inicio) return inicio;
      }
      return new Response("Sem conexão com a internet.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  })());
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((abas) => abas[0]?.focus() ?? self.clients.openWindow("/")),
  );
});
