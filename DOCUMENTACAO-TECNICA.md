# Busão DF Web — documentação técnica

Documento de referência do estado do projeto verificado em **15/10/2026**.

## 1. Resumo executivo

O Busão DF é uma aplicação web progressiva (PWA) para consultar linhas, paradas,
previsões e veículos de transporte público do Distrito Federal. A aplicação está
publicada em:

- Site: <https://busao-df.onrender.com/>
- GitHub: <https://github.com/Joaohenrrique520Interprise/busao-df-web>
- Serviço Render: `busao-df`

O navegador recebe a interface e chama as rotas `/api/*` do próprio site. O
backend Node.js consulta os serviços externos de transporte, normaliza os dados e
devolve um formato estável para a interface. Assim, as credenciais e a lógica de
integração não ficam espalhadas pelo frontend e o navegador não precisa resolver
CORS diretamente.

## 2. Situação online atual

Na verificação deste documento:

| Verificação | Resultado |
| --- | --- |
| `GET https://busao-df.onrender.com/healthz` | HTTP 200, JSON com `status: "ok"` e uptime do processo |
| `GET /api/linhas?q=0.809` | HTTP 200; retornou a linha 0.809 e seus dados tarifários/operadora |
| `GET /api/ao-vivo?...` | HTTP 200 com `Content-Type: text/event-stream`; recebeu dados antes do timeout de observação |
| Deploy | Render com Docker, `autoDeploy: true` e health check em `/healthz` |

O plano Free do Render pode hibernar depois de aproximadamente 15 minutos sem
tráfego. Nesse caso, a URL continua a mesma, mas o primeiro acesso pode demorar
por causa do cold start.

## 3. Arquitetura e fluxo de uma consulta

```text
Usuário (celular ou desktop)
        |
        | HTTPS: HTML, CSS, JS, PWA e mapa
        v
Render: container Docker / Node.js
        |
        | /api/* normaliza, valida, limita, faz cache e trata erros
        v
Mobilibus + OTP + Nominatim
        |
        v
JSON normalizado ou SSE de tempo real
```

1. O Render inicia `node server.mjs` na porta informada por `PORT` (padrão
   local: `3000`).
2. `server.mjs` serve os arquivos estáticos e encaminha `/api/*` para
   `atender()` em `js/motor.js`.
3. `js/motor.js` consulta as APIs externas com timeout de 12 segundos, duas
   tentativas e no máximo seis requisições simultâneas.
4. Respostas repetidas são mantidas em cache de memória pelo TTL de cada recurso.
5. O frontend exibe o resultado no mapa, na folha de informações e nas telas de
   linha/parada/rota.
6. Para tempo real, o servidor mantém uma conexão SSE e envia uma atualização a
   cada 15 segundos, além de heartbeat. O frontend troca para polling de
   `/api/agora` quando SSE não está disponível ou não entrega dados em 10 segundos.

## 4. Linguagens e tecnologias

### Código da aplicação

- **JavaScript moderno (ES modules)**: frontend e backend.
- **HTML5**: estrutura e acessibilidade da interface.
- **CSS3**: tema claro/escuro, layout responsivo e estados do mapa/painel.
- **JSON**: configuração (`package.json`, `render.yaml`, `railway.json`, manifesto)
  e contratos das APIs.
- **Dockerfile**: build e execução reprodutível no Render/Railway.
- **Batch/PowerShell**: scripts auxiliares para iniciar e compartilhar o servidor
  local no Windows.

Não há dependências npm de runtime no momento: o servidor usa módulos nativos do
Node (`node:http`, `node:fs`, `node:path`, `node:os`).

### Bibliotecas e componentes

- **Node.js 18+** no contrato do projeto; o ambiente local preparado tem Node.js
  24 LTS e npm.
- **MapLibre GL JS**, mantido em `vendor/`, para renderizar o mapa vetorial.
- **OpenFreeMap/OpenMapTiles** para estilo e tiles do mapa.
- **Service Worker** próprio (`sw.js`) para o App Shell offline.
- **Capacitor (compatibilidade)**: `js/dados.js` e `js/motor.js` permitem que a
  mesma lógica rode futuramente dentro de um app Android, atendendo as rotas
  localmente no motor JavaScript nativo.

## 5. APIs internas do projeto

Todas as rotas abaixo são `GET` (também há resposta para `OPTIONS`), retornam
JSON e usam erro padronizado `{ "detail": "..." }`. A única exceção é
`/api/ao-vivo`, que é um stream SSE.

| Rota | Função | Parâmetros principais |
| --- | --- | --- |
| `/healthz` | Saúde do processo para Render/Docker | nenhum |
| `/api/linhas` | Busca linhas por número ou nome | `q` |
| `/api/linhas/:id` | Detalhe da linha, sentidos, trajeto e paradas | `id` na URL |
| `/api/linhas/:id/minha-parada` | Próximas passagens da linha na posição/parada escolhida | `lat`, `lon` ou `parada` |
| `/api/paradas/proximas` | Paradas próximas com chegadas | `lat`, `lon` |
| `/api/paradas/area` | Paradas que cobrem a área visível do mapa | `lat`, `lon`, `raio` |
| `/api/paradas/identificar` | Casa nome/coordenada a um ID de parada | `nome`, `lat`, `lon` |
| `/api/paradas/:id/chegadas` | Próximas chegadas de uma parada | `id` na URL |
| `/api/rota` | Linhas diretas e itinerários de transporte | `de=lat,lon`, `para=lat,lon` |
| `/api/endereco` | Converte endereço ou coordenada em posição no DF | `q` |
| `/api/agora` | Snapshot de veículos e previsões em tempo real | `lat`, `lon`, opcional `linha`, `parada` |
| `/api/ao-vivo` | Stream SSE que repete o snapshot | mesmos parâmetros de `/api/agora` |

## 6. APIs e serviços externos utilizados

### Mobilibus

Base: `https://mobilibus.com/api`.

- `/routes`: catálogo de linhas (`project_hash=3c189`).
- `/agencies`: operadoras.
- `/timetable`: tabela/horários da linha (`route_hash`).
- `/trip-details`: detalhes de viagem, paradas e geometria do trajeto.
- `/vehicles`: posições atuais dos veículos.
- `/departures`: partidas/previsões por parada.
- `/search-stops`: busca de paradas.

O código mantém cache diferente por tipo: veículos e partidas ficam poucos
segundos em cache; catálogo, agências e detalhes históricos podem ficar horas.

### OTP/Mobilibus

Base: `https://otp.mobilibus.com/FY7J-lwk85QGbn/otp/routers/default`.

- `/index/stops`: paradas próximas/na área do mapa.
- `/plan`: planejamento de itinerários com `TRANSIT,WALK`.

### Nominatim/OpenStreetMap

Base: `https://nominatim.openstreetmap.org/search`.

Usada para geocodificar texto digitado dentro da caixa do Distrito Federal. O
pedido envia `User-Agent`, limita a busca ao Brasil e à caixa geográfica do DF.

### Mapas e fontes

- Estilos/tiles: `https://tiles.openfreemap.org/styles/liberty` e `.../styles/dark`.
- Atribuição exibida na interface: OpenFreeMap, OpenMapTiles e OpenStreetMap.
- Fonte visual: Google Fonts, família Manrope.

Não há chave de API, senha ou `.env` necessário para o funcionamento atual.

## 7. Tempo real, GPS e confiabilidade

- O navegador pede geolocalização de alta precisão e não aceita uma posição GPS
  antiga como se fosse nova.
- Sem GPS, o usuário pode informar endereço, coordenada ou escolher uma região
  pré-configurada do DF.
- Saltos impossíveis de GPS são filtrados pelo módulo `js/movimento.js`.
- O relógio do aparelho é corrigido pelo timestamp recebido do servidor.
- A previsão possui níveis de confiança e diferencia veículo confirmado,
  estimado e situação incerta.
- Os metadados `wa` e `ac` da Mobilibus são normalizados e apresentados como
  selos de acessibilidade e ar-condicionado somente quando confirmados.
- Paradas e terminais reconhecidos recebem badges de integração com Metrô-DF ou
  BRT nas opções de rota e baldeação.
- O alarme de proximidade usa a sequência do veículo em tempo real para avisar a
  até três paradas; quando a sequência não existe, usa um raio de 1,2 km. O aviso
  combina notificação do navegador, vibração e dois tons discretos.
- A conexão SSE envia `config`, `dados` e `erro`; o cliente reconecta e muda para
  polling quando necessário.

## 8. Offline e cache

`sw.js` instala um App Shell com HTML, CSS, JavaScript, manifesto, ícones e
MapLibre. Esses arquivos são revalidados e podem ser usados quando a rede cai.

Por segurança e atualidade:

- respostas de `/api/*` nunca entram no cache do Service Worker;
- localização do usuário nunca é armazenada no cache;
- preferências locais (tema, favoritos, locais salvos e alertas) ficam no
  `localStorage` do próprio navegador;
- arquivos versionados com `?v=...` podem receber cache longo, enquanto a página
  inicial e o Service Worker são revalidados.

## 9. Deploy e infraestrutura

### Render (produção atual)

O `render.yaml` define:

- serviço web `busao-df`;
- runtime Docker;
- plano Free;
- `Dockerfile` na raiz;
- health check `/healthz`;
- deploy automático a cada atualização da branch principal.

O Dockerfile faz duas etapas: valida a sintaxe de todos os módulos e depois
executa uma imagem `node:18-alpine` com usuário sem privilégios `node`. O processo
expõe a porta `3000` e tem `HEALTHCHECK` interno.

### Railway (alternativa configurada)

`railway.json` e o mesmo Dockerfile permitem publicar o projeto no Railway. Essa
configuração existe como alternativa, mas a URL verificada atualmente é a do
Render.

## 10. Estrutura de arquivos

```text
server.mjs              servidor HTTP, estáticos, JSON e SSE
js/motor.js             integrações externas, cache, regras e rotas da API
js/dados.js             cliente HTTP/SSE, relógio e dados locais
js/app.js               telas, busca, GPS, favoritos, alertas e eventos
js/mapa.js              MapLibre, veículos, paradas e trajeto
js/movimento.js         filtros de movimento GPS
js/folha.js             painel responsivo do app
index.html              shell HTML e carregamento dos módulos
estilo.css              visual responsivo e temas
sw.js                   Service Worker/App Shell offline
manifest.webmanifest    instalação como PWA
vendor/                 MapLibre GL JS/CSS local
icones/                 ícones PWA
Dockerfile              imagem e health check do container
render.yaml             deploy atual no Render
railway.json            deploy alternativo
test.mjs                 testes automatizados
```

## 11. Como executar e atualizar

Localmente, dentro da pasta do projeto:

```powershell
npm start
npm test
```

O servidor abre em `http://localhost:3000`. Para mudar a porta:

```powershell
$env:PORT = 8080
npm start
```

Fluxo recomendado de atualização:

1. alterar o código na cópia local;
2. executar `npm test`;
3. testar `/healthz` e as telas principais localmente;
4. revisar `git diff`;
5. criar commit na `main` e executar `git push origin main`;
6. acompanhar o deploy automático e validar novamente a URL do Render.

## 12. Pontos de atenção

- A aplicação depende da disponibilidade e do formato das APIs Mobilibus, OTP e
  Nominatim; uma mudança externa pode exigir ajuste em `js/motor.js`.
- O plano Free do Render pode hibernar.
- SSE exige conexão persistente; por isso o fallback de polling é importante em
  túneis e ambientes que não suportam streaming.
- O mapa depende de tiles externos e pode ficar sem fundo quando esses serviços
  estão indisponíveis, embora a interface e os dados possam continuar acessíveis.
- Antes de publicar qualquer mudança, nunca adicionar tokens, senhas, arquivos
  `.env` ou dados pessoais ao Git.
