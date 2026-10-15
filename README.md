# Busão DF Web 1.1

PWA com frontend HTML/CSS/JavaScript e backend Node.js puro. O backend serve a aplicação e executa `atender()` de `js/motor.js` para que o navegador consulte a Mobilibus sem bloqueio de CORS. Não há dependências npm de runtime.

## Recursos concluídos

- API JSON em `/api/*`, com CORS e erros padronizados como `{ "detail": "..." }`.
- Tempo real por SSE em `/api/ao-vivo`, reconexão em 5 segundos e heartbeat a cada 15 segundos.
- Health check em `/healthz`, incluindo o uptime do processo.
- Geolocalização nova e de alta precisão, sem aceitar posição armazenada pelo navegador.
- Indicador de **GPS preciso**, **aproximação pela rede/IP** ou **local informado manualmente**.
- Alternativas quando o GPS falha: busca manual e regiões do DF (Plano Piloto, Taguatinga, Riacho Fundo I, Ceilândia, Samambaia e Gama).
- App Shell offline com Service Worker v4; respostas da API e localização nunca são armazenadas.
- Encerramento gracioso de conexões HTTP e SSE.
- Docker, Render, Railway, scripts Windows e testes automatizados.

## Executar no Windows

Requer Node.js 18 ou superior.

1. Instale o [Node.js](https://nodejs.org/) se necessário.
2. Extraia o ZIP para uma pasta normal.
3. Dê dois cliques em `iniciar.bat`.
4. Abra `http://localhost:3000` no computador.

O script confere a instalação e a versão do Node.js antes de iniciar. Se o Firewall do Windows perguntar, autorize o Node.js em redes privadas.

Também é possível usar PowerShell:

```powershell
cd "C:\caminho\para\BusaoDF-Web"
npm start
```

Para usar outra porta:

```powershell
$env:PORT = 8080
npm start
```

## Abrir no celular com GPS

Não use `http://192.168.x.x:3000` para testar GPS no iPhone: navegadores bloqueiam geolocalização em páginas HTTP. Use o túnel HTTPS:

1. Dê dois cliques em `compartilhar.bat`.
2. O script inicia o servidor automaticamente se ele não estiver aberto.
3. Copie o endereço `https://...trycloudflare.com` exibido pelo Cloudflare.
4. Abra no celular e permita a localização precisa.

O [Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) é temporário: o endereço muda quando o processo reinicia e só funciona enquanto o computador e o túnel estão ligados.

## Testes automatizados

Execute:

```powershell
npm test
```

Os testes verificam:

- sintaxe e inicialização dos módulos;
- exportações de `js/motor.js`;
- `/healthz`;
- consulta real `/api/linhas?q=0.809` na Mobilibus;
- abertura e eventos iniciais de `/api/ao-vivo`.

Para executar sem a consulta externa da Mobilibus:

```powershell
$env:SKIP_LIVE_API = "1"
npm test
```

Testes manuais rápidos:

```powershell
Invoke-RestMethod http://localhost:3000/healthz
Invoke-RestMethod "http://localhost:3000/api/linhas?q=0.809"
```

## Docker

```powershell
docker build -t busao-df .
docker run --rm -p 3000:3000 busao-df
```

O contêiner usa `node:18-alpine`, roda como usuário sem privilégios `node` e possui `HEALTHCHECK` em `/healthz`.

## Publicar no GitHub

Crie no GitHub um repositório vazio, sem README ou `.gitignore` automático. Nesta pasta, execute:

```powershell
git init
git add .
git commit -m "Publica Busão DF Web"
git branch -M main
git remote add origin https://github.com/Joaohenrrique520Interprise/busao-df-web.git
git push -u origin main
```

Nunca envie `.env`, senhas ou tokens. Consulte também o [guia oficial do GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).

## Deploy no Render

1. Acesse [dashboard.render.com](https://dashboard.render.com/) e conecte o GitHub.
2. Escolha **New > Blueprint** para usar `render.yaml`, ou **New > Web Service** e selecione o repositório.
3. Confirme runtime **Docker**, plano **Free** e health check `/healthz`.
4. Crie o serviço e abra o endereço `https://NOME.onrender.com`.

O `render.yaml` já define Docker, plano Free, deploy automático e encerramento gracioso. O [Render Free](https://render.com/docs/free) hiberna após 15 minutos sem tráfego; a URL permanece a mesma, mas o primeiro acesso pode ter cold start.

## Deploy no Railway

1. Acesse [railway.com](https://railway.com/) usando o GitHub.
2. Escolha **Deploy from GitHub repo** e selecione o repositório.
3. O Railway detectará `railway.json` e o `Dockerfile`.
4. Em **Settings > Networking**, clique em **Generate Domain**.
5. Abra o endereço `https://...up.railway.app`.

O `railway.json` configura Dockerfile, `/healthz`, timeout de inicialização e reinício em falha. Consulte a [referência oficial de configuração](https://docs.railway.com/config-as-code/reference).

## Cache e atualização

- `index.html`, `sw.js`, manifesto e API: sempre revalidados ou não armazenados.
- Arquivos com `?v=4` ou hash no nome: cache imutável de um ano.
- Ícones sem versão: cache de um dia com revalidação em segundo plano.
- Service Worker: `skipWaiting()` e `clients.claim()`; uma versão nova recarrega a página uma vez.

Se uma instalação antiga continuar aparecendo, feche as abas do Busão DF e abra novamente. Em último caso, limpe os dados do site no navegador.

## Estrutura

```text
BusaoDF-Web/
├── server.mjs
├── test.mjs
├── package.json
├── Dockerfile
├── .dockerignore
├── .gitignore
├── render.yaml
├── railway.json
├── iniciar.bat
├── compartilhar.bat
├── index.html
├── estilo.css
├── manifest.webmanifest
├── sw.js
├── icones/
├── js/
└── vendor/
```
