/*
 * GoLiveBypass standalone - devolve o Go Live e a camera para contas brasileiras
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Roda dentro do processo principal do Discord, sem Equicord e sem Vencord. Nao ha renderer,
 * nao ha patch de webpack e nao ha etapa de build: este arquivo e carregado direto, entao o
 * usuario nao precisa de Node, nem de pnpm, nem de git.
 *
 * Por que so o processo principal basta: a trava do cliente vem de um experimento que o
 * servidor atribui a partir do IP de origem do websocket de gateway. Com o gateway saindo por
 * um IP nao bloqueado o experimento nao e atribuido, e os botoes ficam livres sozinhos. Nao ha
 * o que corrigir no cliente quando a origem esta certa.
 *
 * E por que o roteamento e por host, e nao pela sessao inteira: sem renderer nao existe o
 * aviso de "a sessao abriu", que e quando a versao de plugin solta o proxy. Uma regra que vale
 * so para o gateway nao precisa ser solta nunca, entao o resto do Discord sai direto o tempo
 * todo, na velocidade normal.
 */

"use strict";

const { app, session } = require("electron");
const { createServer, connect } = require("net");
const { connect: connectTls } = require("tls");
const { request } = require("https");
const fs = require("original-fs");
const { join, dirname, basename, resolve } = require("path");

const DISCORD_HOST = "discord.com";
const GEO_HOST = "cloudflare.com";

// So estes hosts atravessam o tunel. O gate e decidido na conexao do gateway, entao rotear
// mais que isso custaria velocidade em tudo sem comprar nada.
const ROUTED_HOSTS = ["gateway.discord.gg", "remote-auth-gateway.discord.gg"];

const PROBE_TIMEOUT_MS = 6000;
// Mais candidatas por lote nao custa relogio, porque elas correm juntas: custa a mais lenta,
// nao a soma. E com mais candidatas o minimo escolhido e melhor, o que se traduz direto em
// menos latencia em tudo que passa pelo gateway.
const PARALLEL_PROBES = 30;
// Cinco em vez de tres: as candidatas do lote correm juntas, entao guardar mais reserva nao
// custa relogio nenhum na busca e e exatamente o que sobra quando uma saida morre no meio de
// uma transmissao.
const POOL_SIZE = 5;
// Com cinco fontes, o limite alto de candidatas permite varrer uma fatia grande da oferta;
// o probe em paralelo faz a varredura custar o tempo do mais lento, nao a soma.
const MAX_CANDIDATES = 80;
const MIN_UPTIME = 90;
const MAX_LISTED_TIMEOUT = 1500;
const TOR_PORTS = [9060, 9052, 9150, 9050, 9250];
const TOR_PORT_TIMEOUT_MS = 400;
// Quanto uma conexao de gateway espera por uma saida antes de sair direta. Segurar para sempre
// travaria o login; soltar na hora perderia a corrida em toda abertura fria.
const HOLD_BUDGET_MS = 12_000;
// No modo "tor" o bootstrap do daemon leva ~20s numa maquina fria, e neste modo estourar o
// prazo nao vira saida direta (o serveSocks recusa), entao esperar mais e barato: o custo e
// o gateway demorar a conectar, nao vazar. No BOOT do Windows o orcamento e maior ainda na
// pratica: a GUI e um processo Electron a parte, que precisa terminar o proprio arranque
// ANTES de sequer chamar o Tor -- o Discord (nativo, mais rapido) costuma vencer a corrida
// (issue #116: "carregamento infinito" so no modo tor, so ao abrir com o Windows). Por isso
// 90s em vez de 45s: com o aviso visivel (showTorBootBanner) esperar mais nao confunde, e o
// custo so aparece no primeiro Discord aberto depois de ligar o PC.
const TOR_HOLD_BUDGET_MS = 90_000;
// O pool guardado vale por este tempo. A revalidacao acontece na abertura (probe real em
// cada saida), entao uma idade longa e segura: o que importa e ter candidatas para revalidar
// em vez de baixar a lista inteira (lenta) com o gateway ja conectando. 30min fazia o pool
// expirar entre aberturas do Discord e o gateway nascia direto — o "carregando infinitamente".
const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// Depois de uma busca por saida nova falhar, espera este intervalo antes de tentar de novo:
// a API de saidas gratuitas custa e nao responde mais rapido por repeticao. Quinze segundos
// mantem a resposta razoavel para a sessao que ficou sem saida (com vinte e cinco a morte da
// ativa virava quase um minuto enxugando o gateway).
const REFRESH_COOLDOWN_MS = 15_000;

// Trava da reposicao de rotina. Tres minutos, igual ao plugin: sem ela, um pote que nao
// consegue encher viraria uma varredura inteira da lista gratuita a cada trinta segundos, pela
// sessao toda. E separada da trava acima para a rotina nunca adiar a emergencia.
const STOCK_COOLDOWN_MS = 3 * 60_000;

// Prazo do tunel no trafego vivo, bem menor que o do teste: uma saida agonizante que demora a
// falhar faria o Chromium desistir do roteador inteiro.
const RELAY_TIMEOUT_MS = 2500;

// Prazo do tunel no modo tor, pelo contrario, folgado: o SOCKS CONNECT do Tor constroi
// circuito novo quando o anterior expirou (MaxCircuitDirtiness ~10 min) e isso leva 5-30s --
// o SocksTimeout do Tor e 60s+. Com o prazo de saida gratuita (2.5s) o cliente abortava uma
// conexao que o Tor completaria segundos depois, e o gateway so reconectava no proximo ciclo
// de backoff (janelas de minutos sem gateway na issue #122). No tor nao existe alternativa
// (nunca sai direto), entao esperar nao custa nada: o cliente do gateway ja recebeu a
// resposta do SOCKS e espera pacientemente o handshake.
const TOR_RELAY_TIMEOUT_MS = 30_000;

// De quanto em quanto tempo as saidas sao reconferidas com a sessao ja aberta. O refreshExit
// conserta depois que uma conexao falha; o batimento existe para que ela nao chegue a falhar.
// Trinta segundos e curto o bastante para a reserva estar quente quando o gateway reconectar,
// e longo o bastante para nao virar carga na saida gratuita, que costuma limitar conexoes.
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 4000;

// Uma saida manual pode ser legitimamente mais lenta que uma gratuita. Aplicar os 4s do
// pote a ela transforma latencia em "morte" e abre a exata troca de gateway que as #170/#171
// mostraram ser destrutiva no retorno do viewer. Ela so muda depois de dois testes deste prazo.
const MANUAL_HEARTBEAT_TIMEOUT_MS = 12_000;

// Quantos batimentos seguidos uma saida pode errar antes de sair do pote. Cortar no primeiro
// seria cruel com saida gratuita congestionada, que erra um e volta; nunca cortar deixaria o
// pote cheio de endereco morto, que e o mesmo que nao ter reserva nenhuma.
const MAX_MISSED_BEATS = 2;

// Abaixo disto o batimento vai atras de reservas novas. Uma so nao e reserva: e a proxima a
// morrer.
const MIN_LIVE_RESERVES = 2;

// ------------------------------------------------------------------ estabilidade da sessao
// Uma saida gratuita passa no probe e ainda assim entrega mal: RTT alto e instavel faz o
// websocket do gateway perder heartbeat e reconectar em loop, derrubando o carregamento.
// A troca proativa ataca antes de a conexao sofrer.

// Acima disto a saida e considerada lenta demais para o gateway. Medido como EMA do RTT
// dos probes (a media exponencial suaviza picos momentaneos sem ignorar degradacao real).
const RTT_TROCA_MS = 450;
// RTT lento por N batimentos seguidos vira troca: um pico isolado nao aposenta saida boa.
const RTT_TROCA_BATIDAS = 3;
// Fator da EMA (0.3 = o RTT novo pesa 30%, o historico 70%).
const RTT_EMA_ALPHA = 0.3;

// O medidor mais confiavel de sofrimento e o proprio gateway: reconexoes em rajada (3+ em
// 180s) significam que a saida nao esta aguentando o trafego vivo, mesmo passando no probe.
// Acima disto, troca forcada de saida — e reseta o contador.
const RECONEXAO_JANELA_MS = 180_000;
const RECONEXAO_LIMITE = 3;

// Cooldown das trocas PROATIVAS (por RTT ou por rajada): quando o pool inteiro esta lento,
// trocar em cascata vira ping-pong entre ruins — cada troca faz o gateway renascer e a
// sessao recarregar. Esperar o cooldown suaviza; a troca por saida MORTA e emergencia e
// nao passa por aqui.
const SWAP_COOLDOWN_MS = 60_000;
// Nas trocas proativas, so vale trocar para uma reserva pELO MENOS tao boa quanto a atual:
// trocar para outra lenta (ou pior) nao ajuda o gateway e ainda o faz renascer a toa.
const SWAP_RESERVA_RAZAO = 1.2;

// Prazo global da busca por saidas, do inicio ao fim (nao por lote): o probe completo numa
// candidata de RTT medio leva ~4-8s (duas conexoes + TLS), entao um prazo curto por lote
// cortava os probes antes de aprovarem e a busca voltava vazia — o gateway nascia direto e
// a sessao ficava bloqueada (video nunca chega, so audio). Os lotes correm ate este prazo e
// a melhor aprovada que tiver chegado vence.
const HUNT_BUSCA_TOTAL_MS = 10_000;

const MAX_LOG_BYTES = 2 * 1024 * 1024;

// ------------------------------------------------------------------ recarga apos gateway direto
// O roteador abre direto para um host de gateway quando nenhuma saida entrega; essa sessao
// nasce pelo IP brasileiro e o servidor bloqueia (o "carregando infinitamente"). Quando a
// saida voltar a ficar pronta, recarregar a janela do Discord faz o gateway renascer atras
// dela. Guardas contra loop: teto por execucao, cooldown, single-flight e a saida tem que
// estar comprovadamente entregando antes do reload.
const RELOAD_MAX_RETRIES = 2;
const RELOAD_COOLDOWN_MS = 30_000;
// Depois de quanto tempo sem ver o gateway direto o sinal expira: uma recarga tardia
// derrubaria uma sessao que ja se recuperou sozinha.
const DIRECT_SIGNAL_TTL_MS = 60_000;
// A janela do cliente, nao a splash (que nunca tem URL discord.com).
const CLIENT_URL_RE = /^https:\/\/(?:canary|ptb\.)?discord\.com\/(?:app|channels|login)/;

const HERE = __dirname;
const SETTINGS_FILE = join(HERE, "settings.json");
const STATE_FILE = join(HERE, "state.json");

// O log vai para uma pasta ESTAVEL, nao para HERE. Quando a GUI injeta, HERE e a pasta do
// app.asar do Discord: um lugar que ninguem adivinha e que some quando o Discord se atualiza
// ou o bypass e desativado. A pasta abaixo e a mesma que o app e o plugin usam (%LOCALAPPDATA%
// \GoLiveBypass no Windows, $XDG_DATA_HOME/GoLiveBypass no Linux/Mac) -- e onde a pessoa
// naturalmente procura, e um arquivo so, que sobrevive a atualizacao do Discord.
function logDir() {
    const base = process.platform === "win32"
        ? process.env.LOCALAPPDATA
        : (process.env.XDG_DATA_HOME
            || (process.env.HOME ? join(process.env.HOME, ".local", "share") : undefined));
    return base ? join(base, "GoLiveBypass") : null;
}
const LOG_FILE = logDir() === null ? null : join(logDir(), "golivebypass.log");

let socksPort = 0;
let chosenExit = null;
let exitSettled = false;
// Reservas ja testadas. Uma saida gratuita morre sem avisar, e sem reserva a unica alternativa
// seria refazer a busca inteira no meio da sessao.
let pool = [];
const waitingForExit = [];
// Estado da re-selecao em runtime: so uma busca por vez, e nunca antes do cooldown.
let refreshingExit = null;
let lastRefreshAt = 0;
let lastStockAt = 0;
// Quantos batimentos seguidos cada saida errou. Fora do pote de proposito: o pote vai para
// disco, e isto e estado desta sessao.
const missedBeats = new Map();
let beating = false;
let stocking = null;

// Medicao de qualidade por saida (estado desta sessao): EMA do RTT dos probes e quantos
// batimentos seguidos ela ficou acima do teto. A troca por RTT so acontece depois de
// RTT_TROCA_BATIDAS leituras ruins seguidas — pico momentaneo nao aposenta saida boa.
const rttEma = new Map();          // proxy -> EMA do RTT (ms)
const rttLentoSeguidas = new Map(); // proxy -> batimentos ruins consecutivos

// Janela deslizante das reconexoes do gateway (so o cliente real conecta em
// gateway-*.discord.gg). A rajada e o sinal de que a saida nao aguenta o trafego vivo.
const gatewayReconexoes = [];      // timestamps das reconexoes na janela
let ultimaTrocaProativaEm = 0;    // cooldown das trocas proativas (RTT/rajada)

// Quarentena de saidas que ja causaram sofrimento: a saida passa no probe e mesmo assim o
// gateway sofre; sem um "nao voltar para essa agora", o refresh reelege exatamente ela (a
// mesma mai famosa do dia). Fica de fora por QUARENTENA_MS e o pool e obrigado a testar
// alternativas.
const QUARENTENA_MS = 90_000;
const quarentena = new Map();     // proxy -> ate quando fica evitada

function quarentenar(proxy, motivo) {
    if (proxy === null) return;
    // O modo Tor tem exatamente uma saida autorizada. Marcar esse endereco como
    // evitado depois de uma rajada nao cria alternativa alguma e contradiz a
    // garantia "so Tor, nunca direta"; no proximo caminho que consulte a
    // quarentena, poderia transformar uma oscilacao recuperavel em ausencia de
    // rota. A rajada continua diagnosticada, mas o Tor unico e preservado.
    if (routeMode === "tor") {
        log(safeProxy(proxy) + " poupada da quarentena por ser a saida unica do modo tor (" + motivo + ")");
        return;
    }
    if (proxy === manualProxy()) {
        log(safeProxy(proxy) + " poupada da quarentena por ser a saida configurada (" + motivo + ")");
        return;
    }
    const ate = Date.now() + QUARENTENA_MS;
    const ja = quarentena.get(proxy);
    if (ja === undefined || ate > ja) quarentena.set(proxy, ate);
    log(safeProxy(proxy) + " em quarentena ate daqui a " + Math.round(QUARENTENA_MS / 1000) + "s (" + motivo + ")");
}

function foraDeQuarentena(itens) {
    const agora = Date.now();
    for (const [proxy, ate] of quarentena) if (ate <= agora) quarentena.delete(proxy);
    return itens.filter(item => !quarentena.has(typeof item === "string" ? item : item.proxy));
}

// Troca proativa de saida com cooldown: impede o ping-pong entre saidas ruins quando o pool
// inteiro esta lento. A troca por saida MORTA (emergencia) chama trocarPara direto.
function trocaProativaPode() {
    return Date.now() - ultimaTrocaProativaEm > SWAP_COOLDOWN_MS;
}

function trocarPara(nova, motivo) {
    ultimaTrocaProativaEm = Date.now();
    gatewayReconexoes.length = 0;
    missedBeats.delete(nova);
    rttLentoSeguidas.delete(nova);
    const antiga = chosenExit;
    const vida = antiga === null || lastExitAt === 0 ? "?" : Math.round((Date.now() - lastExitAt) / 1000) + "s";
    log("saida.trocada | de=" + (antiga === null ? "nenhuma" : safeProxy(antiga)) +
        " para=" + safeProxy(nova) +
        " motivo=" + motivo +
        " vida_da_antiga=" + vida);
    chosenExit = nova;
    // Corrige o "saida pronta ha Ns" mentindo: sem isto, trocas em runtime
    // (openThroughPool) nao atualizavam e o log do gateway mostrava a idade
    // da saida ORIGINAL.
    lastExitAt = Date.now();
}

// Estado da recarga pos-gateway-direto.
let gatewayWentDirectAt = 0;   // quando o roteador abriu direto para um host de gateway
let reloadCount = 0;           // recargas nesta execucao (reseta quando a sessao volta roteada)
let lastReloadAt = 0;          // cooldown
let reloading = false;         // single-flight
// O probe termina antes da espera por reserva. Este mutex cobre essa segunda fase;
// sem ele, um segundo sinal de gateway direto podia agendar outro reload enquanto o
// primeiro ainda aguardava a reserva viva.
let directReloadPending = false;

// Estado do arranque frio em modo tor: quando o Discord abre (ou o Windows liga) antes do
// Tor da GUI terminar de subir, as conexoes de gateway ficam SEGURADAS (nunca vazam direto --
// ver HOLD_BUDGET_MS/TOR_HOLD_BUDGET_MS). Sem aviso a pessoa so ve "carregando" para sempre e
// nao sabe se travou ou se e so questao de tempo (issue #116). Este timestamp marca quando a
// espera comecou; zerado assim que uma saida real aparece (settleExit), momento em que o
// banner some e a janela recarrega sozinha em vez de esperar o proprio Discord perceber e
// tentar de novo por conta propria (que pode demorar mais que so tentar na hora).
let coldTorHoldSince = 0;

// O banner de arranque frio promete "menos de um minuto". Verdadeiro para o bootstrap do Tor
// em si, mas nao cobre o caso em que o PROCESSO da GUI (dono do Tor e do watchdog que o
// ressuscita) fechou ou travou -- o runtime injetado no Discord nao tem como subir Tor
// sozinho, entao sem isto a pessoa fica lendo "deve sumir sozinho" para sempre. Passado este
// prazo (bem alem do bootstrap normal, generoso o bastante para nao confundir uma rede lenta
// com o processo morto) o aviso vira acionavel: dizer para reabrir a GUI, nao so o Discord.
let torBootStallShown = false;

// Falhas seguidas do probe da saida MANUAL (nao do trafego vivo -- so a checagem de fundo em
// chooseExit). Uma falha isolada pode ser um blip; falhas repetidas em toda abertura sao o
// padrao de credencial/endereco errado (ex.: SOCKS5 recusa a autenticacao) que nenhum retry
// sozinho resolve -- e o "de Ctrl+R" que o projeto recomenda em outras issues NAO ajuda aqui,
// porque Ctrl+R so recarrega o renderer (a pagina), nao o processo principal onde mora o
// roteador: ele continua preferindo a mesma saida quebrada (issue: "loading infinito mesmo
// dando control r" -- o usuario reabria o Discord varias vezes achando que ia resolver, e a
// unica coisa que resolvia de verdade era o fallback automatico para o Tor, sem aviso nenhum
// de que o problema era a PROXY configurada). Contador de PROCESSO, nao persistido: reabrir
// o Discord comeca a contagem de novo, entao uma saida que voltou a funcionar nao carrega
// alarme velho.
let manualProxyFalhasSeguidas = 0;
const MANUAL_PROXY_AVISO_LIMITE = 2;
let manualProxyBannerMostrado = false;

// Pasta estavel onde a GUI le os logs (sobrevive a updates do Discord e a
// desativacao). Espelhar aqui e o que permite o report de bug pegar o log do
// bypass mesmo depois de o app.asar injetado ser apagado.
const MIRROR_DIR = (() => {
    try {
        if (process.platform === "win32" && process.env.LOCALAPPDATA) {
            return join(process.env.LOCALAPPDATA, "GoLiveBypass", "logs");
        }
        const base = process.env.XDG_DATA_HOME || join(require("os").homedir(), ".local", "share");
        return join(base, "GoLiveBypass", "logs");
    } catch {
        return "";
    }
})();
const MIRROR_MAX_BYTES = 2 * 1024 * 1024;

function log(line) {
    const stamp = new Date().toTimeString().slice(0, 8);
    if (LOG_FILE !== null) try {
        // Sem comando de diagnostico aqui, o arquivo e a unica forma de saber o que aconteceu.
        // Ele e cortado sozinho para nao crescer sem fim numa maquina que ninguem limpa.
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
            fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, "utf8").slice(-MAX_LOG_BYTES / 2));
        } else if (!fs.existsSync(LOG_FILE)) {
            // A pasta pode nao existir ainda (injecao numa maquina que nunca rodou o app).
            fs.mkdirSync(dirname(LOG_FILE), { recursive: true });
        }
        fs.appendFileSync(LOG_FILE, stamp + " " + line + "\n");
    } catch {
        // Ficar sem registro e ruim; derrubar o Discord por causa do registro e pior.
    }

    // Espelho para a pasta estavel (falha silenciosa: nunca derruba o Discord).
    if (MIRROR_DIR !== "") {
        try {
            const alvo = join(MIRROR_DIR, "bypass.log");
            fs.mkdirSync(MIRROR_DIR, { recursive: true });
            if (fs.existsSync(alvo) && fs.statSync(alvo).size > MIRROR_MAX_BYTES) {
                fs.renameSync(alvo, join(MIRROR_DIR, "bypass.1.log"));
            }
            fs.appendFileSync(alvo, stamp + " " + line + "\n");
        } catch {
            // silencioso
        }
    }

    console.log("[GoLiveBypass]", line);
}

function readJson(file, fallback) {
    try {
        let content = fs.readFileSync(file, "utf8");
        if (content && content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        return JSON.parse(content.trim());
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    try {
        fs.writeFileSync(file, JSON.stringify(value, null, 4));
    } catch (error) {
        log("nao consegui gravar " + basename(file) + ": " + error.message);
    }
}

const settings = readJson(SETTINGS_FILE, {});
const excludedCountries = new Set(
    (typeof settings.excludedCountries === "string" ? settings.excludedCountries : "BR")
        .split(",").map(code => code.trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code))
);

// Rede de saida escolhida na GUI. "tor" = padrao seguro (so Tor, nunca vaza direto).
// "free" = gratuitas. "auto" = Tor se houver, senao gratuitas.
const routeMode = typeof settings.routeMode === "string" ? settings.routeMode : "tor";
// O endereco do Tor pode vir das settings (a GUI sobe o proprio numa porta dedicada).
const TOR_ADDR = typeof settings.torAddr === "string" && settings.torAddr !== ""
    ? settings.torAddr
    : "127.0.0.1:9060";
// Recuperacao do gateway zumbi e do RTC da stream e obrigatoria. Ela continua
// conservadora por desenho: as guardas de midia/call, o teto e os cooldowns
// decidem QUANDO agir; settings.json nunca pode desarmar a protecao critica.

// Primeira linha do log: o modo EFETIVO que este runtime vai usar.
log("modo de roteamento: " + routeMode +
    (typeof settings.routeMode === "string" ? " (settings.json)" : " (padrao: tor estrito com 1ms nativo)"));
log("recuperacao automatica obrigatoria: gateway e RTC (guardas de midia ativas)");

// Se estiver no modo tor e habilitado, despacha arranque imediato do Tor em paralelo com o carregamento do Discord
if ((routeMode === "tor" || settings.enabled !== false) && typeof ensureTorRunning === "function") {
    ensureTorRunning();
}

// O trecho antes do @ e opcional e casado com ganancia, para a senha poder conter @ e : sem
// precisar de escape: quem recebe um endereco pronto da AWS costuma cola-lo como veio.
// Agora suporta RANGE de portas para proxies multiplexados, ex: 10000-10050
const PROXY_RE = /^(socks5|socks4|http|https):\/\/(?:(.+)@)?([^:/?#\s@]+):(\d{1,5})(?:-(\d{1,5}))?$/;

function parseProxy(value) {
    const match = PROXY_RE.exec(String(value).trim());
    if (match === null) return null;

    const portStart = Number(match[4]);
    if (portStart < 1 || portStart > 65535) return null;
    let finalPort = portStart;

    // Se tiver range, sorteia uma porta do range
    if (match[5] !== undefined) {
        const portEnd = Number(match[5]);
        if (portEnd >= portStart && portEnd <= 65535) {
            finalPort = Math.floor(Math.random() * (portEnd - portStart + 1)) + portStart;
        }
    }

    // Dividido no primeiro dois-pontos, entao a senha pode ter quantos quiser.
    const credentials = match[2] === undefined ? "" : match[2];
    const split = credentials.indexOf(":");
    const decode = value => {
        try {
            return decodeURIComponent(value);
        } catch {
            // Um % solto no meio da senha nao e escape, e literal.
            return value;
        }
    };

    return {
        scheme: match[1],
        user: credentials === "" ? "" : decode(split < 0 ? credentials : credentials.slice(0, split)),
        pass: credentials === "" || split < 0 ? "" : decode(credentials.slice(split + 1)),
        host: match[3],
        port: finalPort
    };
}

// Nunca registrar a senha: o registro vai para arquivo e as pessoas colam ele em relato de
// problema.
function safeProxy(value) {
    const parsed = parseProxy(value);
    if (parsed === null) return "endereco invalido";

    return parsed.scheme + "://" + (parsed.user === "" ? "" : parsed.user + ":***@") + parsed.host + ":" + parsed.port;
}

function manualProxy() {
    // A GUI preserva o texto do campo ao trocar de modo para a pessoa poder
    // voltar a "Personalizado" sem redigitar a credencial. Preservar o TEXTO
    // nao pode preservar a PRECEDENCIA: Tor e Gratuitas sao escolhas
    // explicitas e nao podem herdar uma proxy manual de uma sessao anterior.
    if (routeMode !== "auto") return "";
    const raw = settings.proxy;
    if (typeof raw !== "string" || raw.trim() === "") return "";

    const parsed = parseProxy(raw);
    if (parsed === null) return null;

    // Retorna a string ja renderizada com a porta sorteada (se houver range)
    return parsed.scheme + "://" +
           (parsed.user !== "" ? parsed.user + ":" + parsed.pass + "@" : "") +
           parsed.host + ":" + parsed.port;
}

// Saida manual/privada configurada (com ou sem range multiplexado). Usada para desligar a
// reposicao de reserva e a troca proativa por RTT: sao mecanismos pensados para saida
// GRATUITA, que morre sem avisar e precisa de troca em segundo plano. Numa saida privada,
// entrar neles so custa (ver trySwapByRtt e stockReserves).
const hasConfiguredManualProxy = typeof settings.proxy === "string" && settings.proxy.trim() !== "" && parseProxy(settings.proxy) !== null;
const usingManualProxy = routeMode === "auto" && hasConfiguredManualProxy;
if (hasConfiguredManualProxy && !usingManualProxy) {
    log("proxy personalizada salva ignorada: modo " + routeMode + " foi escolhido explicitamente");
}

// A saida ativa e uma das portas configuradas pela pessoa? Comparacao por string falha
// para range: manualProxy() sorteia uma porta nova a cada chamada, entao a mesma saida
// ativa nunca bateria com uma leitura nova. Aqui confere host e se a porta cai dentro do
// intervalo configurado (um range vira um intervalo de 1 porta so).
function isManualAddress(proxy) {
    if (proxy === null || !usingManualProxy) return false;
    const match = PROXY_RE.exec(String(settings.proxy).trim());
    if (match === null) return false;
    const candidato = parseProxy(proxy);
    if (candidato === null || candidato.host !== match[3]) return false;
    const portStart = Number(match[4]);
    if (match[5] === undefined) return candidato.port === portStart;
    // Mesma convencao do parseProxy: range invalido (portEnd < portStart ou > 65535) cai
    // para porta unica (portStart). Sem isto, isManualAddress rejeita uma porta que o
    // parseProxy aceitou -- o tryReturnToManual nunca reconhece a ativa como manual e
    // fica tentando trocar a cada 90s para uma porta que ele mesmo ja' sorteou.
    const portEnd = Number(match[5]);
    if (portEnd < portStart || portEnd > 65535) return candidato.port === portStart;
    return candidato.port >= portStart && candidato.port <= portEnd;
}

// ------------------------------------------------------------------ falar com uma saida

function readReply(socket, size, done) {
    const chunks = [];
    let settled = false;

    const finish = reply => {
        if (settled) return;
        settled = true;
        socket.off("data", onData);
        socket.off("close", onClose);
        done(reply);
    };

    const onData = chunk => {
        chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const wanted = size(buffer);
        if (wanted < 0 || buffer.length < wanted) return;

        socket.pause();
        if (buffer.length > wanted) socket.unshift(buffer.subarray(wanted));
        finish(buffer.subarray(0, wanted));
    };

    // Uma saida que aceita a conexao e fecha limpo no meio da negociacao nao gera erro nenhum:
    // FIN nao e erro. Sem escutar o fechamento o retorno so viria quando o prazo estourasse.
    const onClose = () => finish(null);

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.resume();
}

function negotiateSocks5(socket, host, port, credentials, done) {
    // Oferecer o metodo 2 so quando ha credencial: um proxy que aceita os dois escolheria a
    // autenticacao a toa, e ai um usuario vazio seria recusado.
    socket.write(credentials.user === "" ? Buffer.from([5, 1, 0]) : Buffer.from([5, 2, 0, 2]));

    readReply(socket, buffer => (buffer.length < 2 ? -1 : 2), greeting => {
        if (greeting === null || greeting[0] !== 5) return done(false, "etapa=greeting motivo=sem_resposta");

        // 0 = sem autenticacao, 2 = usuario e senha (RFC 1929). Qualquer outra coisa, inclusive
        // 0xFF, significa que o proxy nao aceita nada que a gente sabe fazer.
        if (greeting[1] === 2) {
            const user = Buffer.from(credentials.user, "utf8");
            const pass = Buffer.from(credentials.pass, "utf8");
            if (user.length > 255 || pass.length > 255) return done(false, "etapa=auth motivo=credencial_longa");

            readReply(socket, buffer => (buffer.length < 2 ? -1 : 2), reply => {
                if (reply === null || reply[1] !== 0) return done(false, "etapa=auth motivo=recusada code=socks5:0x" + (reply && reply[1] !== undefined ? reply[1].toString(16) : "??"));
                sendTarget();
            });

            socket.write(Buffer.concat([
                Buffer.from([1, user.length]), user,
                Buffer.from([pass.length]), pass
            ]));
            return;
        }

        if (greeting[1] !== 0) return done(false, "etapa=greeting code=socks5:0x" + greeting[1].toString(16));
        sendTarget();
    });

    function sendTarget() {
        const name = Buffer.from(host, "utf8");
        const message = Buffer.alloc(7 + name.length);
        message[0] = 5;
        message[1] = 1;
        message[2] = 0;
        message[3] = 3;
        message[4] = name.length;
        name.copy(message, 5);
        message.writeUInt16BE(port, 5 + name.length);
        socket.write(message);

        readReply(socket, buffer => {
            if (buffer.length < 5) return -1;
            if (buffer[3] === 1) return 10;
            if (buffer[3] === 4) return 22;
            if (buffer[3] === 3) return 7 + buffer[4];
            return -1;
        }, reply => {
            if (reply !== null && reply[1] === 0) return done(true);
            const code = reply === null ? "??" : "0x" + reply[1].toString(16);
            done(false, "etapa=connect code=socks5:" + code);
        });
    }
}

function negotiateConnect(socket, host, port, credentials, done) {
    // O proxy HTTP nao negocia metodo: ou a credencial vai junto do CONNECT, ou ele responde
    // 407 e a conexao ja era.
    const auth = credentials.user === ""
        ? ""
        : "Proxy-Authorization: Basic " + Buffer.from(credentials.user + ":" + credentials.pass, "utf8").toString("base64") + "\r\n";

    socket.write("CONNECT " + host + ":" + port + " HTTP/1.1\r\nHost: " + host + ":" + port + "\r\n" + auth + "\r\n");

    readReply(socket, buffer => {
        const end = buffer.indexOf("\r\n\r\n");
        return end < 0 ? -1 : end + 4;
    }, reply => {
        if (reply === null) return done(false, "etapa=http motivo=sem_resposta");
        const linha = reply.toString("latin1").split("\r\n")[0];
        if (/ 200 /.test(linha)) return done(true);
        const status = (linha.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || "??";
        done(false, "etapa=http code=" + status);
    });
}

function openTunnel(proxy, host, port, timeoutMs) {
    return new Promise(resolve => {
        const parsed = parseProxy(proxy);
        if (parsed === null) return resolve(null);

        let settled = false;
        const inicio = Date.now();
        const finish = (value, motivo) => {
            if (settled) return;
            settled = true;
            if (value === null) socket.destroy();
            else socket.setTimeout(0);
            // Log da causa da falha do tunel — o diagnostico que hoje some:
            // etapa (tcp/greeting/auth/connect/tls), errno (ECONNREFUSED/ETIMEDOUT)
            // e code (rep SOCKS / status HTTP do CONNECT).
            if (value === null && motivo) {
                log("[net] tunel.falha | alvo=" + host + ":" + port + " saida=" + safeProxy(proxy) + " " + motivo + " ms=" + (Date.now() - inicio));
            }
            resolve(value);
        };

        const socket = connect({ host: parsed.host, port: parsed.port });
        socket.setTimeout(timeoutMs || PROBE_TIMEOUT_MS, () => finish(null, "etapa=tcp motivo=timeout"));
        socket.on("error", e => finish(null, "etapa=tcp errno=" + (e && e.code ? e.code : "desconhecido")));
        socket.once("connect", () => {
            const done = (ok, motivo) => finish(ok ? socket : null, ok ? undefined : motivo);
            if (parsed.scheme === "socks5") negotiateSocks5(socket, host, port, parsed, done);
            else negotiateConnect(socket, host, port, parsed, done);
        });
    });
}

function readOverTls(socket, host, path, timeoutMs) {
    return new Promise(resolve => {
        let body = "";
        let settled = false;

        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(null), timeoutMs || PROBE_TIMEOUT_MS);
        const tls = connectTls({ socket, servername: host, host }, () => {
            tls.write("GET " + path + " HTTP/1.1\r\nHost: " + host + "\r\nAccept: */*\r\nConnection: close\r\n\r\n");
        });

        tls.setEncoding("latin1");
        tls.on("error", () => finish(null));
        // Fechamento limpo do host sem dado nao gera erro TLS: sem escutar o close,
        // o retorno ficava preso ate o timer de timeout estourar.
        tls.on("close", () => finish(body || null));
        tls.on("data", chunk => {
            body += chunk;
            if (body.length > 65536) finish(body);
        });
        tls.on("end", () => finish(body));
    });
}

// So o aperto de mao TLS, sem pedir pagina nenhuma. Serve para hosts que nao respondem HTTP --
// o gateway e websocket -- e ainda assim prova o que importa: a saida alcanca o host e o
// certificado fecha, entao ela nao esta sendo barrada por reputacao ali.
function tlsHandshake(socket, host, timeoutMs) {
    return new Promise(resolve => {
        let settled = false;

        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            tls.destroy();
            resolve(value);
        };

        const timer = setTimeout(() => finish(false), timeoutMs || PROBE_TIMEOUT_MS);
        const tls = connectTls({ socket, servername: host, host }, () => finish(true));

        tls.on("error", () => finish(false));
        // Um host que aceita a conexao e fecha limpo antes do handshake nao gera erro: sem
        // isto o retorno so viria quando o prazo estourasse.
        tls.on("close", () => finish(false));
    });
}

// Prova o que interessa numa saida: o tunel negocia, o TLS fecha com certificado valido para o
// Discord, e o Discord responde 200 por ela. Saida barrada por reputacao falha exatamente aqui,
// que e o motivo de o teste nao ser contra um endereco qualquer.
async function probe(proxy, timeoutMs, torProbe) {
    const started = Date.now();

    // No modo "tor" o teste e feito contra o host que a saida REALMENTE vai carregar. O
    // discord.com fica atras da Cloudflare, que recusa o handshake TLS vindo de exit de Tor
    // ("tls alert handshake failure", medido em 2026-08-23) -- e o roteador nunca manda
    // discord.com pela saida, so *.discord.gg. Ou seja: a saida era reprovada por um host que
    // ela nunca ia atender, e o modo tor ficava preso em "porta aberta mas nao respondeu como
    // proxy" com o Tor de pe e o gateway alcancavel (TLS ate gateway.discord.gg em ~600ms).
    //
    // O mesmo vale para o detectTor nos modos auto/free (torProbe): sem isso, o probe HTTP
    // contra discord.com reprovava um Tor do sistema perfeitamente saudavel e o "auto"
    // ("Tor local se houver, senao gratuitas") caia direto no pool gratuito -- exatamente o
    // cenario da issue #108. A prova e o handshake TLS ate o gateway: o /api/v9/gateway nao
    // existe nesse host (ele e websocket), entao exigir HTTP 200 nao faria sentido. Um exit
    // que fecha TLS com o gateway entrega o que precisamos.
    const torHost = routeMode === "tor" || torProbe === true;
    const host = torHost ? ROUTED_HOSTS[0] : DISCORD_HOST;

    const socket = await openTunnel(proxy, host, 443, timeoutMs);
    if (socket === null) return null;

    if (torHost) {
        if (!await tlsHandshake(socket, host, timeoutMs)) return null;
    } else {
        const response = await readOverTls(socket, host, "/api/v9/gateway", timeoutMs);
        if (response === null || (!response.startsWith("HTTP/1.1 200") && !response.startsWith("HTTP/1.1 404"))) return null;
    }

    const ms = Date.now() - started;
    // Alimenta a EMA de RTT da saida: a troca proativa por lentidao le desta leitura.
    const ema = rttEma.has(proxy) ? rttEma.get(proxy) : ms;
    rttEma.set(proxy, ema + RTT_EMA_ALPHA * (ms - ema));

    return { proxy: proxy, ms: ms };
}

// O host que reporta o pais de saida quando o trace da Cloudflare nao traz um loc de pais
// real — exatamente o que acontece com exits do Tor (o loc vem como "T1") e com varias
// gratuitas. O ipwho.is responde via Tor/US; ifconfig.co provou ser instavel demais.

// Cache do pais de saida de Tor. O exit do Tor muda a cada ~10min (novo circuito), entao
// um cache de TOR_GEO_TTL_MS = 8min descreve o pais certo com 1 consulta por circuito,
// independente de quantas vezes o heartbeat rodou. Sem cache, o ipwho.is receberia 1
// consulta por batimento e estourava a cota -- 37 relays BR em 10k explica o porquê dessa
// escolha ter sido a primeira coisa pensada quando o modo tor virou "sem checagem de pais".
const TOR_GEO_TTL_MS = 8 * 60 * 1000;
const torGeoCache = new Map();

function torGeoFresh(entry) {
  return entry !== undefined && Date.now() < entry.ate;
}

async function exitCountryTorCached(proxy, timeoutMs) {
  const cached = torGeoCache.get(proxy);
  if (torGeoFresh(cached)) return cached.pais;
  const pais = await exitCountry(proxy, timeoutMs);
  if (pais === null) return null;
  torGeoCache.set(proxy, { pais: pais, ate: Date.now() + TOR_GEO_TTL_MS });
  return pais;
}


const GEO_FALLBACK_HOST = "ipwho.is";

async function exitCountry(proxy, timeoutMs) {
    // O trace da Cloudflare prova o tunel e o pais numa conexao so; e o caminho rapido.
    const socket = await openTunnel(proxy, GEO_HOST, 443, timeoutMs);
    if (socket !== null) {
        const response = await readOverTls(socket, GEO_HOST, "/cdn-cgi/trace", timeoutMs);
        const match = response === null ? null : /^loc=([A-Z]{2})/m.exec(response);
        // "T1" e o codigo especial que a Cloudflare usa para exits do Tor: nao e um pais.
        if (match !== null && match[1] !== "T1") return match[1];
    }

    // Fallback: sem um pais de verdade no trace, pergunta ao ipwho.is (JSON com
    // country_code). Sem isto, Tor e varias gratuitas eram recusadas como "saida em pais
    // desconhecido" mesmo com o tunel funcionando.
    try {
        const fallback = await openTunnel(proxy, GEO_FALLBACK_HOST, 443, timeoutMs);
        if (fallback !== null) {
            const json = await readOverTls(fallback, GEO_FALLBACK_HOST, "/?fields=country_code", timeoutMs);
            const iso = json === null ? null : /"country_code"\s*:\s*"([A-Z]{2})"/.exec(json);
            if (iso !== null) return iso[1];
        }
    } catch {
        // sem o pais, o chamador recusa a saida — melhor que assumption errada
    }

    return null;
}

// As duas conexoes em sequencia de proposito: saida gratuita sobrecarregada costuma limitar
// conexoes simultaneas, e abrir duas de uma vez reprovaria candidata boa. O paralelismo que
// importa e entre candidatas, no lote que chama esta funcao.
async function probeExit(proxy) {
    const result = await probe(proxy);
    if (result === null) return null;

    result.country = await exitCountry(proxy);
    return result;
}

// ------------------------------------------------------------------ escolher a saida

function downloadText(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = request(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error("resposta inesperada: " + res.statusCode));
            }

            let body = "";
            res.setEncoding("utf8");
            res.on("data", chunk => {
                body += chunk;
                if (body.length > 4_000_000) req.destroy(new Error("resposta grande demais"));
            });
            res.on("end", () => resolve(body));
        });

        req.on("error", reject);
        req.setTimeout(timeoutMs || 15_000, () => req.destroy(new Error("tempo esgotado")));
        req.end();
    });
}

// As listas gratuitas de uma fonte so mudam de vez em quando e variam de qualidade; juntar
// varias fontes dilui a dependencia de uma unica lista e aumenta a chance de achar uma saida
// com RTT decente. A proxyscrape (formato JSON com uptime) segue sendo a primeira; as demais
// trazem candidatas de outras redes. Tudo e testado de verdade pelo probe antes de usar.
const FREE_PROXY_API = "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=json&timeout=1500";
const FREE_PROXY_FONTES = [
    { tipo: "proxyscrape", url: FREE_PROXY_API },
    { tipo: "plain", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt" },
    { tipo: "plain", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt" },
    { tipo: "plain", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt" },
    { tipo: "geonode", url: "https://proxylist.geonode.com/api/proxy-list?limit=80&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5" }
];
// As fontes sao baixadas juntas; prazo curto para a mais lenta nao atrasar a escolha (o
// gateway espera no roteador por ate HOLD_BUDGET_MS).
const FONTES_TIMEOUT_MS = 6000;

// Cada formato de fonte vira a mesma coisa: { proxy, uptime?, timeout?, country? }. O
// timeout quando a fonte reporta e a latencia declarada — usada no ranqueamento, nao como
// verdade (o probe decide).
function parsePlain(body) {
    const itens = [];
    for (const linha of body.split("\n")) {
        const p = linha.trim();
        if (p === "" || p.startsWith("#")) continue;
        // listas "host:port" e "socks5://host:port" convivem; normaliza para o segundo.
        const proxy = p.includes("://") ? p : "socks5://" + p;
        if (parseProxy(proxy) !== null) itens.push({ proxy: proxy });
    }
    return itens;
}

function parseGeonode(body) {
    const data = JSON.parse(body);
    const list = Array.isArray(data.data) ? data.data : [];
    return list.map(entry => ({
        proxy: "socks5://" + entry.ip + ":" + entry.port,
        uptime: typeof entry.upTime === "number" ? entry.upTime : undefined,
        timeout: typeof entry.latency === "number" ? entry.latency : undefined,
        country: String(entry.country || "")
    })).filter(item => parseProxy(item.proxy) !== null);
}

function parseProxyScrape(body) {
    const data = JSON.parse(body);
    const list = Array.isArray(data.proxies) ? data.proxies : [];
    return list.map(entry => ({
        proxy: String(entry.proxy || ""),
        uptime: typeof entry.uptime === "number" ? entry.uptime : undefined,
        timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
        country: String((entry.ip_data && entry.ip_data.countryCode) || "")
    })).filter(item => item.proxy !== "" && parseProxy(item.proxy) !== null);
}

async function fetchFreeProxies() {
    // Se o usuario configurou um range multiplexado, usamos ele como nosso "pool publico" privado.
    // Isso impede que ao falhar a porta principal o app vaze para uma proxy publica aleatoria.
    // O range so e uma saida manual no modo Personalizado. Tor/Gratuitas
    // mantem o texto salvo para a UI, mas nao podem reusar suas portas.
    const raw = settings.proxy;
    if (usingManualProxy && typeof raw === "string" && raw.trim() !== "") {
        const match = PROXY_RE.exec(raw.trim());
        if (match !== null && match[5] !== undefined) {
            const portStart = Number(match[4]);
            const portEnd = Number(match[5]);
            if (portEnd >= portStart && portEnd <= 65535) {
                const poolManual = [];
                for (let p = portStart; p <= portEnd; p++) {
                    const str = `${match[1]}://${match[2] ? match[2] + '@' : ''}${match[3]}:${p}`;
                    poolManual.push({ proxy: str, country: "BR" });
                }
                log("usando " + poolManual.length + " portas do pool multiplexado ao inves de proxies publicas");
                return poolManual;
            }
        }
    }

    const porFonte = await Promise.all(FREE_PROXY_FONTES.map(async fonte => {
        try {
            const body = await downloadText(fonte.url, FONTES_TIMEOUT_MS);
            log("fonte " + fonte.tipo + ": ok (" + body.length + " bytes)");
            if (fonte.tipo === "plain") return parsePlain(body);
            if (fonte.tipo === "geonode") return parseGeonode(body);
            return parseProxyScrape(body);
        } catch (e) {
            log("fonte " + fonte.tipo + ": falhou (" + (e && e.message ? e.message : "erro") + ")");
            return [];
        }
    }));

    // Junta as fontes e tira duplicata (primeira vence; a ordem das fontes define a
    // precedencia quando a mesma saida aparece em duas listas).
    const unicos = new Map();
    for (const itens of porFonte) {
        for (const item of itens) if (!unicos.has(item.proxy)) unicos.set(item.proxy, item);
    }
    return [...unicos.values()];
}

function rankFreeProxies(lista) {
    const base = foraDeQuarentena(lista)
        .filter(entry => entry && entry.proxy)
        .filter(entry => typeof entry.uptime !== "number" || entry.uptime >= MIN_UPTIME)
        .filter(entry => typeof entry.timeout !== "number" || entry.timeout <= MAX_LISTED_TIMEOUT)
        // A porta 4145 e quase toda de intermediario que responde por qualquer destino sem
        // encaminhar nada. Ela reprova no teste, mas so depois de gastar o prazo.
        .filter(entry => !String(entry.proxy).endsWith(":4145"))
        .filter(entry => !excludedCountries.has(String(entry.country).toUpperCase()));

    // As listas sem metadado (plain) nao tem timeout declarado: ordenar so por ele jogaria
    // ~2700 candidatas para o fim e o primeiro lote testaria apenas fontes com campo de
    // latencia — que podem estar todas mortas. Intercala mantendo a melhor de cada lado.
    const comTimeout = base.filter(e => typeof e.timeout === "number").sort((a, b) => a.timeout - b.timeout);
    const semTimeout = base.filter(e => typeof e.timeout !== "number");
    const intercalado = [];
    const fim = Math.max(comTimeout.length, semTimeout.length);
    for (let i = 0; i < fim && intercalado.length < MAX_CANDIDATES; i++) {
        if (i < comTimeout.length) intercalado.push(comTimeout[i]);
        if (i < semTimeout.length && intercalado.length < MAX_CANDIDATES) intercalado.push(semTimeout[i]);
    }

    return intercalado.map(entry => String(entry.proxy));
}

function listening(port, timeoutMs) {
    return new Promise(resolve => {
        const socket = connect({ host: "127.0.0.1", port: port });
        const finish = value => {
            socket.destroy();
            resolve(value);
        };

        socket.setTimeout(timeoutMs, () => finish(false));
        socket.on("error", () => finish(false));
        socket.once("connect", () => finish(true));
    });
}

function savePool() {
    writeJson(STATE_FILE, { pool: pool, at: Date.now() });
}

// Unica janela para o estado das saidas: chosenExit e pool sao locais deste arquivo, e sem isto
// nem o registro nem um teste conseguem dizer o que o batimento decidiu.
function poolStatus() {
    return {
        active: chosenExit,
        pool: pool.map(entry => entry.proxy),
        missed: [...missedBeats.entries()]
    };
}

function ensureTorRunning() {
    try {
        if (process.platform !== "win32") return false;
        const localApp = process.env.LOCALAPPDATA;
        if (!localApp) return false;
        const torExe = join(localApp, "GoLiveBypass", "Tor", "tor", "tor.exe");
        const torrc = join(localApp, "GoLiveBypass", "Tor", "torrc");
        if (fs.existsSync(torExe) && fs.existsSync(torrc)) {
            const { spawn, execSync } = require("child_process");
            try {
                const check = execSync('tasklist /FI "IMAGENAME eq tor.exe" /NH', { encoding: 'utf8', windowsHide: true });
                if (check && check.toLowerCase().includes("tor.exe")) {
                    return true;
                }
            } catch { }
            const child = spawn(torExe, ["-f", torrc], {
                detached: true,
                stdio: "ignore",
                windowsHide: true
            });
            child.unref();
            log("[Tor-Watchdog] Tor iniciado automaticamente em segundo plano.");
            return true;
        }
    } catch (e) {
        log("[Tor-Watchdog] Erro ao iniciar Tor: " + (e ? e.message : e));
    }
    return false;
}

async function detectTor(probeTimeoutMs) {
    const candidatas = routeMode === "tor"
        ? [TOR_ADDR]
        : [...new Set([TOR_ADDR, ...TOR_PORTS.map(port => "127.0.0.1:" + port)])];

    const probeMs = probeTimeoutMs !== undefined ? probeTimeoutMs : PROBE_TIMEOUT_MS;

    for (const addr of candidatas) {
        const proxy = "socks5://" + addr;
        const port = Number(addr.split(":")[1] || 0);
        let isListening = await listening(port, TOR_PORT_TIMEOUT_MS);
        if (!isListening && (routeMode === "tor" || port === 9060)) {
            ensureTorRunning();
            // Polling rapido e ativo a cada 300ms por ate 15s para garantir que o Tor suba com o Discord
            const t0 = Date.now();
            while (Date.now() - t0 < 15000) {
                await new Promise(r => setTimeout(r, 300));
                isListening = await listening(port, 400);
                if (isListening) {
                    log("[Tor-Watchdog] Tor pronto e escutando na porta " + port + " em " + (Date.now() - t0) + "ms");
                    break;
                }
            }
        }
        if (!isListening) continue;
        
        let probeRes = await probe(proxy, probeMs, true);
        if (probeRes === null && routeMode === "tor") {
            // Pequena folga se o socket SOCKS acabou de abrir
            await new Promise(r => setTimeout(r, 1200));
            probeRes = await probe(proxy, probeMs, true);
        }
        if (probeRes === null) {
            log("porta " + port + " esta aberta mas nao respondeu como proxy");
            continue;
        }

        // No modo "tor", o torrc ja contem ExcludeNodes {BR} e StrictNodes 1 forçados.
        // Nao travamos o startup do Discord esperando consultas HTTP lentas.
        if (routeMode === "tor") {
            log("Tor validado com sucesso na porta " + port + " (1ms nativo)");
            return proxy;
        }

        const pais = await exitCountryTorCached(proxy, 6000);
        if (pais !== null && excludedCountries.has(pais)) {
            log("Tor na porta " + port + " recusado: saida em " + pais);
            continue;
        }
        log("Tor encontrado na porta " + port +
            (pais === null ? " (geo nao verificada)" : ", saida em " + pais));
        return proxy;
    }

    return null;
}

// Devolve as aprovadas da busca, sem mexer no pote nem na saida ativa: quem chama decide se
// isto e a escolha da sessao ou so reserva chegando por baixo. As aprovadas vem ORDENADAS
// pelo RTT do probe (menor primeiro): a primeira aprovada que chega costuma ser so a mais
// rapida de CHEGAR, nao a mais rapida de verdade — e colocar uma saida de 1.7s quando a
// busca tinha uma de 400ms e a propria instabilidade que derruba o gateway. Parou de cortar
// probes por lote: o prazo agora e global, e quem completa dentro dele entra na escolha.
async function huntExits() {
    if (routeMode === "tor") {
        return [];
    }
    let candidates;
    try {
        // Baixa as fontes juntas, junta sem duplicata e filtra/ranqueia.
        candidates = rankFreeProxies(await fetchFreeProxies());
    } catch (error) {
        log("nao consegui baixar a lista de saidas: " + error.message);
        return [];
    }

    log(candidates.length + " candidatas depois do ranqueamento");

    const prazoFinal = Date.now() + HUNT_BUSCA_TOTAL_MS;

    for (let i = 0; i < candidates.length; i += PARALLEL_PROBES) {
        const restante = prazoFinal - Date.now();
        if (restante <= 0) break;

        const batch = candidates.slice(i, i + PARALLEL_PROBES);

        // Todas as probes do lote podem completar; a escolha sai no prazo global OU quando o
        // lote terminou — o que vier primeiro. Uma aprovada que chega antes ja entra.
        const aprovadas = await new Promise(resolve => {
            const found = [];
            let pending = batch.length;
            let settled = false;
            const prazo = setTimeout(terminar, restante);

            function terminar() {
                if (settled) return;
                settled = true;
                clearTimeout(prazo);
                resolve(found);
            }

            for (const candidate of batch) {
                probeExit(candidate).then(r => {
                    if (settled) return;

                    if (r !== null && r.country !== null && !excludedCountries.has(r.country)) {
                        found.push(r);
                    } else if (r !== null) {
                        log(r.proxy + " recusada: saida em " + (r.country || "pais desconhecido"));
                    }

                    if (--pending === 0) terminar();
                });
            }
        });

        if (aprovadas.length === 0) continue;

        // Menor RTT primeiro: a ativa vira a melhor da busca, e o pool herda a mesma ordem.
        return aprovadas.sort((a, b) => a.ms - b.ms);
    }

    return [];
}

async function pickFreeExit() {
    const aprovadas = await huntExits();
    if (aprovadas.length === 0) return null;

    pool = aprovadas.slice(0, POOL_SIZE);
    log("escolhida " + pool[0].proxy + ": " + pool[0].ms + "ms, saida em " + pool[0].country);
    if (pool.length > 1) {
        log("reservas: " + pool.slice(1).map(e => e.proxy + " (" + e.ms + "ms " + e.country + ")").join(", "));
    }

    savePool();
    return pool[0].proxy;
}

// O pool esta frio quando nao ha state.json valido: ausente, corrompido, vazio ou
// fora da idade maxima. Leitura barata de proposito -- sem probe, sem quarentena --
// porque quem usa e o estouro do prazo de espera, onde cada milissegundo ja virou
// "Discord carregando". Lista publica de SOCKS5 e ruim por natureza (#95: dezenas de
// tunel.falha em sequencia), entao "pool frio" e o cenario comum de primeira abertura.
function poolFrio() {
    if (pool.length > 0) return false; // esta sessao ja achou saidas; nao e cold start
    const state = readJson(STATE_FILE, null);
    if (state === null || typeof state.at !== "number") return true;
    if (Date.now() - state.at > CACHE_MAX_AGE_MS) return true;
    const itens = Array.isArray(state.pool)
        ? state.pool.filter(e => e && typeof e.proxy === "string")
        : (typeof state.proxy === "string" ? [1] : []); // formato antigo, uma saida so
    return itens.length === 0;
}

async function cachedExit() {
    // No modo "tor" saida guardada nao vale nada: o cache so guarda gratuitas, e deixar
    // ele vencer a escolha fazia o gateway NASCER por proxy gratuita com o Tor de pe
    // (reprovado em teste: cache quente + routeMode tor -> "reaproveitando 3 de 3" e
    // saida gratuita usada sem o Tor ser consultado).
    if (routeMode === "tor") return null;
    const state = readJson(STATE_FILE, null);
    if (state === null || typeof state.at !== "number") return null;
    if (Date.now() - state.at > CACHE_MAX_AGE_MS) return null;

    // Versoes anteriores guardavam uma saida so, em state.proxy. As que estao em quarentena
    // nao sao reeleitas: quem causou sofrimento no passado recente nao volta so por estar
    // guardada.
    const guardadas = foraDeQuarentena(
        Array.isArray(state.pool)
            ? state.pool.filter(e => e && typeof e.proxy === "string")
            : (typeof state.proxy === "string" ? [{ proxy: state.proxy, ms: 0, country: "?" }] : [])
    );

    // Testadas em paralelo e escolhida a mais rapida de agora: a ordem de ontem nao vale hoje,
    // e testar uma por vez gastaria o orcamento inteiro na primeira que tivesse morrido.
    const vivas = (await Promise.all(guardadas.map(async e => {
        const r = await probe(e.proxy, 2500);
        return r === null ? null : { proxy: e.proxy, ms: r.ms, country: e.country };
    }))).filter(Boolean).sort((a, b) => a.ms - b.ms);

    if (vivas.length === 0) return null;

    pool = vivas;
    log("reaproveitando " + vivas.length + " de " + guardadas.length + " saidas guardadas, a melhor com " + vivas[0].ms + "ms");
    return vivas[0].proxy;
}

async function chooseExit() {
    const manual = manualProxy();
    if (manual === null) {
        log("o endereco em proxy nao e valido, ignorando");
    } else if (manual !== "") {
        // Saida escolhida e gravada pela pessoa nas settings: usar NA HORA, sem probe.
        // O probe completo (TLS ate o Discord) gasta ~1s, e o gateway conecta em menos —
        // com a escolha devagar a corrida morre e a sessao nasce direta pelo IP brasileiro
        // (o "carregando infinitamente" no video). Com a saida na mao em milissegundos o
        // gateway ja nasce roteado; o batimento valida a cada 30s, e se ela estiver morta
        // o trafego vivo cai para reserva/cache/lista antes de ir direto.
        log("usando a saida que voce configurou: " + safeProxy(manual));
        probe(manual, MANUAL_HEARTBEAT_TIMEOUT_MS).then(ok => {
            if (ok === null) {
                log("a saida que voce configurou nao respondeu ao probe em segundo plano: " + safeProxy(manual));
                manualProxyFalhasSeguidas++;
                if (manualProxyFalhasSeguidas >= MANUAL_PROXY_AVISO_LIMITE) showManualProxyFailedBanner();
            } else {
                manualProxyFalhasSeguidas = 0;
            }
        });
        return manual;
    }

    const cached = await cachedExit();
    if (cached !== null) return cached;

    // Modo "tor": SO o Tor conta. Sem Tor nao ha saida — o gateway fica segurado (nunca
    // vaza direto para o IP brasileiro), e o refresh continua tentando ate o Tor voltar.
    if (routeMode === "tor") {
        const tor = await detectTor();
        if (tor !== null) return tor;
        log("modo tor: nenhum Tor respondeu em " + TOR_ADDR + ", segurando o gateway (sem saida direta)");
        return null;
    }

    // Modo "free": pula o Tor (quem escolheu gratuitas nao quer depender de Tor).
    if (routeMode === "free") {
        const free = await pickFreeExit();
        if (free !== null) return free;
        // Sem gratuitas vivas (lista toda morta e o cache vazio): a sessao morreria
        // direto pelo IP brasileiro, que e EXATAMENTE o "load infinito" da issue #85.
        // Tenta o Tor como ultimo recurso antes de desistir -- o Tor ja esta rodando
        // (a GUI sobe na inicializacao do modo tor e nao desliga se o usuario trocou
        // para gratuitas), e com o fix de pais (PR #82) garante que exits BR sao
        // recusados. Melhor um Tor lento que um Discord travado.
        log("nenhuma gratuita viva, tentando o Tor local como fallback");
        return await detectTor();
    }

    return await detectTor() || await pickFreeExit();
}

let lastExitAt = 0; // quando a saida atual foi escolhida (para o log do gateway visto)

function settleExit(proxy) {
    chosenExit = proxy;
    exitSettled = true;
    if (proxy !== null) lastExitAt = Date.now();
    while (waitingForExit.length > 0) waitingForExit.shift()(proxy);

    // Saida real depois de um arranque frio em modo tor: some com o aviso e recarrega a
    // janela na hora, em vez de esperar o Discord perceber sozinho que pode tentar de novo
    // (o backoff dele nao e nosso e pode demorar bem mais que isto). Guarda antes de
    // maybeReloadAfterDirect de proposito: sao sinais diferentes (seguro vs vazou), e o
    // primeiro nunca chega a marcar gatewayWentDirectAt (modo tor nunca vaza).
    if (proxy !== null && coldTorHoldSince !== 0) {
        coldTorHoldSince = 0;
        torBootStallShown = false;
        hideTorBootBanner();
        maybeReloadAfterColdHold();
    }

    // Saida nova no ar e o gateway tinha saido direto ha pouco: esta sessao nasceu bloqueada
    // e so um reload faz o gateway renascer atras da saida. Avalia (com todas as guardas).
    if (proxy !== null && gatewayWentDirectAt !== 0) {
        maybeReloadAfterDirect();
    }
}

// ------------------------------------------------------------------ recarga pos-gateway-direto

function clientWindow() {
    const janelas = janelasCliente();
    return janelas.length > 0 ? janelas[0] : null;
}

// TODAS as janelas do cliente (a #154 passou 3 minutos sem probe: o poll pode
// cair numa janela sem o shim enquanto a janela viva tem outro webContents).
function janelasCliente() {
    const achadas = [];
    for (const win of require("electron").BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
            if (CLIENT_URL_RE.test(win.webContents.getURL())) achadas.push(win);
        } catch {
            // janela morrendo
        }
    }
    return achadas;
}

// Reservas vivas no pool (excluindo a ativa). A recarga depende disto: renascer o gateway
// com o pool de 1 so deixava a sessao vulneravel a morte da ativa no renascimento (o caso
// do ciclo 7 do teste de estresse — 8s de "carregando" sem reserva para assumir).
const RELOAD_MIN_RESERVES = 1;
const RELOAD_RESERVE_WAIT_MS = 10_000;

function liveReserveCount() {
    return pool.filter(entry => entry.proxy !== chosenExit).length;
}

function maybeReloadAfterDirect() {
    // Sinal expirado: o gateway direto foi ha tempo demais, a sessao pode ter se recuperado.
    if (Date.now() - gatewayWentDirectAt > DIRECT_SIGNAL_TTL_MS) {
        gatewayWentDirectAt = 0;
        return;
    }
    if (reloading || directReloadPending || reloadCount >= RELOAD_MAX_RETRIES) return;
    if (Date.now() - lastReloadAt < RELOAD_COOLDOWN_MS) return;

    const exit = chosenExit;
    if (exit === null) return;

    reloading = true;
    directReloadPending = true;
    let handedOff = false;
    // A saida tem que estar comprovadamente entregando AGORA: recarregar com saida morta
    // repetiria a mesma falha e gastaria uma tentativa a toa.
    probe(exit, 2500).then(ok => {
        if (ok === null) {
            log("saida " + safeProxy(exit) + " nao respondeu, adiando a recarga");
            return;
        }

        // NAO cancela por roteado recente: a reconexao roteada depois da corrida perdida nao
        // desbloqueia a sessao (o veredito foi no CONNECTION_OPEN original, direto). So a
        // recarga da janela faz o gateway renascer atras da saida de verdade.

        // Espera por reserva viva (ate RELOAD_RESERVE_WAIT_MS): o renascimento pos-recarga
        // precisa de uma reserva para assumir na hora se a ativa morrer (o caso raro do ciclo
        // 7). Se o pool ja tem, segue direto. Se o gateway rotear no meio (corrida ganha),
        // cancela — a recarga nao e mais necessaria.
        handedOff = true;
        ensureReserveThenReload(exit);
    }).catch(error => {
        log("a checagem antes da recarga falhou: " + error.message);
    }).finally(() => {
        reloading = false;
        if (!handedOff) directReloadPending = false;
    });
}

function ensureReserveThenReload(exit) {
    const release = () => { directReloadPending = false; };
    const tryReload = () => {
        // Cancela se a sessao se resolveu sozinha (gateway passou pela saida).
        if (Date.now() - lastRoutedAt < 3000) {
            log("gateway ja passou pela saida, recarga desnecessaria");
            gatewayWentDirectAt = 0;
            release();
            return;
        }
        const win = clientWindow();
        if (win === null) {
            log("nao achei a janela do cliente Discord para recarregar");
            release();
            return;
        }
        reloadCount++;
        lastReloadAt = Date.now();
        gatewayWentDirectAt = 0; // so recarrega uma vez por sinal
        log("o gateway tinha saido direto, recarregando atras de " + safeProxy(exit) + " (tentativa " + reloadCount + " de " + RELOAD_MAX_RETRIES + ")");
        win.webContents.reload();
        release();
    };

    if (liveReserveCount() >= RELOAD_MIN_RESERVES) return tryReload();

    // Sem reserva: busca em background e espera um pouco. A sessao ja esta bloqueada, entao
    // esperar nao piora; recarregar vulneravel deixaria o renascimento a merce da ativa.
    log("sem reserva viva, enchendo o pote antes de recarregar");
    stockReserves(liveReserveCount());

    const deadline = Date.now() + RELOAD_RESERVE_WAIT_MS;
    const poll = setInterval(() => {
        if (Date.now() - lastRoutedAt < 3000) {
            clearInterval(poll);
            log("gateway ja passou pela saida, recarga desnecessaria");
            gatewayWentDirectAt = 0;
            release();
            return;
        }
        if (liveReserveCount() >= RELOAD_MIN_RESERVES) {
            clearInterval(poll);
            log("reserva disponivel, recarregando agora");
            tryReload();
            return;
        }
        if (Date.now() >= deadline) {
            clearInterval(poll);
            // Prazo estourado: recarrega mesmo sem reserva — a sessao ja esta bloqueada, e
            // segurar mais so prolonga o "carregando". O refresh runtime cobre a morte.
            log("prazo de reserva estourado, recarregando mesmo assim");
            tryReload();
        }
    }, 2000);
}

// A sessao voltou a nascer roteada (conexao de gateway passou pela saida): reseta o teto de
// recargas — e o sinal de que a ultima recarga (se houve) funcionou.
let lastRoutedAt = 0;
// A saida ativa entregou trafego de gateway recentemente (isto e o probe mais fiel possivel:
// o proprio gateway esta vivo por ela). O batimento usa isto para NAO abrir uma conexao de
// probe na ativa a cada 30s — saida gratuita limita conexoes simultaneas, e o probe extra
// concorre com a conexao do gateway e pode derruba-la. A morte real da ativa aparece no
// trafego vivo (openThroughPool), nao precisa do probe para ser percebida.
let ativaEntregouEm = 0;
// Quantas vezes o gateway nasceu roteado nesta execucao. A primeira e so a abertura normal;
// da segunda em diante e uma RECONEXAO de verdade no meio da sessao (confirmado ao vivo em
// 2026-08-23, com CDP: mesmo uma troca limpa, sem vazar direto, sem trocar de saida visivel,
// trava o video do Go Live so-audio — o motor de voz/video do Discord e WASM fechado, entao
// nao da pra restartar so o stream por fora sem mexer no binario. O que da pra fazer com
// seguranca e avisar: a pessoa decide se vale reiniciar (Ctrl+R sai da call) ou nao.
let gatewayConnCount = 0;

// Quando vimos um websocket de voz/video pela ultima vez. O aviso de reconexao so faz sentido
// com chamada ou transmissao em andamento: fora disso a reconexao do gateway nao quebra nada
// visivel, e avisar so assustaria -- ainda por cima sugerindo um Ctrl+R que derruba a call.
//
// Esta marca so ATUALIZA quando um websocket de midia NOVO abre (entrar numa call, ligar a
// camera) -- uma call ja em andamento, sem novo handshake, nao a renova. Numa call longa e
// estavel (comum: streams/reunioes de dezenas de minutos) o timestamp fica parado desde a
// entrada. Por isso a janela e generosa (20min, nao 5): um valor curto classificaria uma
// call longa como "sem midia" e o autoReloadForCleanEngine recarregaria a janela NO MEIO da
// chamada, exatamente o dano que esta guarda existe para evitar. Vinte minutos nao elimina o
// risco para calls mais longas que isso (o projeto nao inspeciona o payload do gateway para
// saber se a call segue de pe -- so os hosts de handshake, por design), mas reduz bastante a
// janela de perigo sem custar nada em troca (o pior caso sem isto e so o banner manual, que
// ja e o comportamento seguro de antes desta funcao existir).
let ultimaMidiaEm = 0;
const MIDIA_RECENTE_MS = 20 * 60_000;

// Uma stream nativa de discord_voice e prova mais forte de chamada/Live que o
// websocket *.discord.media. Em sessoes longas de viewer esse websocket pode
// sumir da instrumentacao apesar de o decoder continuar recebendo video; foi
// exatamente o que a #178 registrou. Centralizar a marca evita que cada
// mecanismo automatico invente uma definicao diferente de "sem midia".
function marcarMidiaProtegida() {
    ultimaMidiaEm = Date.now();
}

function midiaProtegidaRecentemente(janelaMs) {
    const janela = typeof janelaMs === "number" ? janelaMs : MIDIA_RECENTE_MS;
    return ultimaMidiaEm > 0 && Date.now() - ultimaMidiaEm < janela;
}

// Trocar a rota do gateway enquanto uma call/Live esta de pe e uma corrida
// perigosa: o Chromium pode reavaliar a sessao no mesmo instante em que o
// addon discord_voice renegocia o RTC. A troca nao e necessaria para uma
// saida que ainda responde; se ela depois morrer, a troca de emergencia pelo
// primeiro batimento perdido continua disponivel. A janela e a mesma usada
// para impedir reload automatico no meio de uma chamada e cobre a ocorrencia
// real de 01/09 (a Live estava aberta ha ~19min quando a troca por RTT ocorreu).
function midiaRecenteParaTrocaProativa() {
    return midiaProtegidaRecentemente(MIDIA_RECENTE_MS);
}

// Um Ctrl+R (ou a nossa propria recarga) comeca uma sessao NOVA: o gateway que nascer depois
// dela e o primeiro dela, nao uma reconexao no meio de nada. Sem zerar aqui, o aviso voltava
// justamente para quem seguiu o conselho dele -- recarregou por causa do aviso e levou o mesmo
// aviso de novo, agora sem motivo.
function watchReloads() {
    const electron = require("electron");
    electron.app.on("browser-window-created", (_evento, win) => {
        win.webContents.on("did-start-loading", () => {
            // A URL ainda e a de antes quando a recarga comeca: se era a do cliente, isto e um
            // reload de verdade, e nao a splash abrindo.
            let url = "";
            try {
                url = win.webContents.getURL();
            } catch {
                return; // janela morrendo
            }
            if (!CLIENT_URL_RE.test(url)) return;
            // A navegacao de verdade comecou: libera o mutex de reload (reloadPorRevive() e o
            // unico dos tres chamadores de win.webContents.reload() que nao tinha um probe
            // assincrono proprio para resetar sozinho -- ver reloadPorRevive()). Redundante e
            // inofensivo para os outros dois caminhos, que ja resetam no proprio .finally().
            reloading = false;
            // Invalida qualquer resultado assíncrono do documento anterior,
            // inclusive quando a conexão ainda não chegou a ser contada.
            gatewayProbeEpoca++;
            // O probe RTC pode estar consultando o documento antigo. Invalida
            // o resultado e impede que o finally dessa execução antiga libere
            // o mutex de uma consulta já iniciada na sessão nova.
            voiceProbeEpoca++;
            gatewayProbeBloqueadoAte = new WeakMap();
            if (gatewayConnCount > 0) {
                log("a janela do Discord recarregou: contagem de reconexao zerada");
            }
            gatewayConnCount = 0;
            // Reload = sessao nova de verdade: o estado do zumbi/revive expira junto
            // (o banner era DOM do documento antigo e ja morreu com ele).
            zumbiBannerAtivo = false;
            zumbiTentativaEm.length = 0;
            zumbiUltimaAcaoEm = 0;
            zumbiUltimaAcao = null;
            revivePendenteEm = 0;
            reviveFecharEm = 0;
            reviveFecharOrigem = '';
            // O documento e as conexoes nativas antigas morreram. Nenhuma
            // tentativa RTC pode atravessar a fronteira do reload e agir sobre
            // sockets da sessao nova.
            videoNativoPendente = null;
            videoNativoTentativas.length = 0;
            videoNativoOrcamentoChave = '';
            videoNativoBloqueadoGeracao = '';
            videoNativoBloqueadoEm = 0;
            videoNativoUltimaAcaoEm = 0;
            videoBannerAtivo = false;
            voiceProbeUltimaAssinatura = '';
            voiceUltimaGeracaoLogada = '';
            viewerNativoUltimaSaudavelGeracao = '';
            viewerNativoUltimaSaudavelEm = 0;
        });
    });
}
// Precisa existir antes de o main original criar a primeira BrowserWindow. Se
// fosse instalado dentro de start(), os awaits do roteador/PAC poderiam perder
// a janela e todo reset de sessao daquela execucao.
try {
    watchReloads();
} catch (error) {
    log("nao consegui observar as recargas da janela: " + error.message);
}

// Telemetria de sessao para o log: contagens acumuladas (a rotacao do arquivo
// apaga historia — uma linha resumida a cada janela preserva o quadro geral).
let sessaoRoteadas = 0;
let sessaoDiretas = 0;
let sessaoReloads = 0;
let sessaoRevives = 0;      // acoes da escada de revive (close 4000 + reloads por zumbi)
let ultimoVistoAt = 0;      // quando o gateway foi visto pela ultima vez (gw.visto)
let ultimoRoteadoAt = 0;    // quando o gateway roteou pela ultima vez (gw.roteado)
let sessaoInicio = Date.now();
let estatTimer = null;

function emitirEstat() {
    estatTimer = null;
    log("estat.sessao | uptime=" + Math.round((Date.now() - sessaoInicio) / 1000) + "s" +
        " roteadas=" + sessaoRoteadas + " diretas=" + sessaoDiretas +
        " reloads=" + sessaoReloads +
        " revives=" + sessaoRevives +
        " reconexoes_janela=" + (typeof gatewayReconexoes !== "undefined" ? gatewayReconexoes.length : "?") +
        " saida_atual=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
}
function agendarEstat() {
    if (estatTimer === null) {
        estatTimer = setTimeout(emitirEstat, 180_000);
    }
}

// === voice shim: inicio ===
// O Discord desktop atual nao usa window.RTCPeerConnection para a call/Go Live:
// as conexoes reais nascem no addon discord_voice. A beta 10 envolvia a API do
// Chromium e, por isso, reportava pcs=0 durante uma Live nativa saudavel. Este
// shim entra antes do bundle, envolve o carregamento do addon sem mudar seus
// argumentos/retornos e expoe somente forma + contadores sanitizados. A decisao
// de recuperacao fica no main; formato desconhecido nunca vira acao.
function instalarVoiceShim() {
    if (window.__goliveVoiceShim) return;

    var state = {
        installed: false,
        voiceHooked: false,
        instanceId: Date.now(),
        nextId: 1,
        connections: [],
        seen: new WeakMap(),
        modules: new WeakSet(),
        demands: {
            sender: { known: false, active: false, at: 0, changedAt: 0, epoch: 0 },
            viewer: { known: false, active: false, at: 0, changedAt: 0, epoch: 0 },
        },
        desktopSource: null,
        desktopSourceEpoch: 0,
        retry: 0,
    };
    window.__goliveVoiceShim = state;

    function safeKey(key) {
        key = String(key);
        if (/^[0-9]{10,}$/.test(key)) return '<numeric>';
        if (/^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/.test(key)) return key;
        return '<dynamic>';
    }

    function shape(value, depth, seen) {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        if (depth > 4) return typeof value;
        if (Array.isArray(value)) return { type: 'array', length: value.length };
        if (typeof value !== 'object') return typeof value;
        if (seen.has(value)) return 'circular';
        seen.add(value);
        var out = {};
        var keys;
        try { keys = Object.keys(value).slice(0, 160); } catch (e) { return 'inacessivel'; }
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var cleanKey = safeKey(key);
            var child;
            try { child = value[key]; } catch (e) { out[cleanKey] = 'getter-error'; continue; }
            out[cleanKey] = shape(child, depth + 1, seen);
        }
        return out;
    }

    function finite(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    function firstFinite(obj, names) {
        if (!obj || typeof obj !== 'object') return null;
        for (var i = 0; i < names.length; i++) {
            var value = finite(obj[names[i]]);
            if (value !== null) return value;
        }
        return null;
    }

    // Resume o "transport" (nivel de rede, comum as duas direcoes) numa
    // impressao curta que muda só quando chega confirmacao nova de entrega.
    // Nunca inclui localAddress nem o id do receiverReport (identificadores);
    // so numeros de contagem/qualidade, que sozinhos nao reidentificam nada.
    // So rtt + receiverReports: sao os dois unicos campos que só avancam com
    // confirmacao vinda do outro lado. packetsSent/packetsReceived ficaram de
    // fora de proposito -- sao contagem local (o SO conta como "enviado" um
    // pacote UDP mesmo se o firewall/NAT descartar antes de sair da maquina,
    // e o lado de entrada segue vivo mesmo com a nossa saida bloqueada), entao
    // incluir os dois mascarava exatamente o travamento que essa funcao existe
    // para revelar (medido ao vivo: com saida UDP bloqueada de proposito,
    // packetsReceived/packetsSent continuavam subindo a cada amostra mesmo com
    // rtt e receiverReports parados byte a byte).
    function transportFingerprint(transport) {
        if (!transport || typeof transport !== 'object') return null;
        var reports = Array.isArray(transport.receiverReports) ? transport.receiverReports : [];
        var reportSig = '';
        for (var i = 0; i < reports.length; i++) {
            var r = reports[i];
            if (!r || typeof r !== 'object') continue;
            reportSig += (finite(r.bitrate) || 0) + '.' + (finite(r.fractionLost) || 0) + ';';
        }
        return [finite(transport.rtt), reportSig].join('|');
    }

    // getFilteredStats usa bitmask: 1 = transport (rtt/receiverReports, nivel
    // de rede abaixo do RTP), 2 = outbound/screenshare, 4 = inbound. Pedimos 7
    // para medir as tres. targetMediaBitrate e diagnostico, nao guarda: em
    // 01/09 o Discord manteve esse campo em zero mesmo com a demanda remota
    // positiva e o viewer preso no loading. O transport resolve um caso mais
    // sutil: framesEncoded/fps_out sobem mesmo quando o pacote e descartado
    // antes de sair da maquina (firewall/NAT do sender) porque medem so o
    // encoder local. rtt/receiverReports so avancam com confirmacao real de
    // entrega vinda do outro lado; congelados por muito tempo com o encoder
    // "saudavel" e o sinal de que o sender esta mandando no vazio.
    function normalizeStats(raw, role) {
        var parsed = raw;
        try {
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        } catch (e) {
            return { ok: false, reason: 'json', shape: 'string' };
        }
        if (!parsed || typeof parsed !== 'object') {
            return { ok: false, reason: 'formato', shape: shape(parsed, 0, new WeakSet()) };
        }
        var transportRtt = parsed.transport ? finite(parsed.transport.rtt) : null;
        var transportSig = transportFingerprint(parsed.transport);

        if (role === 'viewer') {
            var inbound = Array.isArray(parsed.inbound) ? parsed.inbound : [];
            var videos = [];
            for (var ui = 0; ui < inbound.length; ui++) {
                var user = inbound[ui];
                if (!user || typeof user !== 'object') continue;
                if (Array.isArray(user.videos)) {
                    for (var uvi = 0; uvi < user.videos.length; uvi++) {
                        if (user.videos[uvi] && typeof user.videos[uvi] === 'object') videos.push(user.videos[uvi]);
                    }
                } else if (user.video && typeof user.video === 'object') {
                    videos.push(user.video);
                }
            }
            if (videos.length === 0) {
                return {
                    ok: true, direction: 'inbound', videoPresent: false,
                    framesDecoded: null, decodeFrameRate: null, renderFrameRate: null,
                    bytesReceived: null, packetsReceived: null, mediaBitrate: null,
                    width: null, height: null,
                    transportRtt: transportRtt, transportSig: transportSig,
                };
            }
            var inboundVideo = videos[0];
            for (var ivi = 1; ivi < videos.length; ivi++) {
                var atual = firstFinite(inboundVideo, ['framesDecoded', 'bytesReceived', 'packetsReceived']) || 0;
                var candidato = firstFinite(videos[ivi], ['framesDecoded', 'bytesReceived', 'packetsReceived']) || 0;
                if (candidato > atual) inboundVideo = videos[ivi];
            }
            var framesDecoded = firstFinite(inboundVideo, ['framesDecoded', 'decodedFrames', 'framesRendered']);
            var decodeFrameRate = firstFinite(inboundVideo, ['decodeFrameRate', 'decodedFrameRate']);
            var renderFrameRate = firstFinite(inboundVideo, ['renderFrameRate', 'frameRate']);
            var bytesReceived = firstFinite(inboundVideo, ['bytesReceived', 'payloadBytesReceived']);
            var packetsReceived = firstFinite(inboundVideo, ['packetsReceived']);
            if (framesDecoded === null && decodeFrameRate === null && renderFrameRate === null &&
                bytesReceived === null && packetsReceived === null) {
                return { ok: false, reason: 'campos-inbound', shape: shape(parsed, 0, new WeakSet()) };
            }
            return {
                ok: true, direction: 'inbound', videoPresent: true,
                framesDecoded: framesDecoded,
                decodeFrameRate: decodeFrameRate,
                renderFrameRate: renderFrameRate,
                bytesReceived: bytesReceived,
                packetsReceived: packetsReceived,
                mediaBitrate: firstFinite(inboundVideo, ['mediaBitrate', 'totalBitrate']),
                width: finite(inboundVideo.width),
                height: finite(inboundVideo.height),
                transportRtt: transportRtt, transportSig: transportSig,
            };
        }

        var outbound = parsed.outbound;
        var video = outbound && outbound.video;
        if ((!video || typeof video !== 'object') && outbound && Array.isArray(outbound.videos)) {
            for (var vi = 0; vi < outbound.videos.length; vi++) {
                var candidate = outbound.videos[vi];
                if (!candidate || typeof candidate !== 'object') continue;
                if (!video || (finite(candidate.framesEncoded) || 0) > (finite(video.framesEncoded) || 0)) video = candidate;
            }
        }
        var screenshare = parsed.screenshare;
        var captureFrames = null;
        if (screenshare && typeof screenshare === 'object') {
            var captureTotal = 0;
            var captureFound = false;
            var captureKeys;
            try { captureKeys = Object.keys(screenshare); } catch (e) { captureKeys = []; }
            for (var ci = 0; ci < captureKeys.length; ci++) {
                var captureKey = captureKeys[ci];
                if (!/frames$/i.test(captureKey) || /(drop|fail|encode|sent|receive)/i.test(captureKey)) continue;
                var captureValue = finite(screenshare[captureKey]);
                if (captureValue === null) continue;
                captureTotal += captureValue;
                captureFound = true;
            }
            if (captureFound) captureFrames = captureTotal;
        }
        if (!video || typeof video !== 'object') {
            return { ok: false, reason: 'sem-video-outbound', shape: shape(parsed, 0, new WeakSet()) };
        }
        var inputFrameRate = finite(video.inputFrameRate);
        var framesEncoded = finite(video.framesEncoded);
        var encodeFrameRate = finite(video.encodeFrameRate);
        if ((captureFrames === null && inputFrameRate === null) || framesEncoded === null || encodeFrameRate === null) {
            return { ok: false, reason: 'campos-outbound', shape: shape(parsed, 0, new WeakSet()) };
        }
        return {
            ok: true, direction: 'outbound', videoPresent: true,
            captureFrames: captureFrames,
            inputFrameRate: inputFrameRate,
            framesEncoded: framesEncoded,
            encodeFrameRate: encodeFrameRate,
            mediaBitrate: finite(video.mediaBitrate),
            targetMediaBitrate: finite(video.targetMediaBitrate),
            width: Array.isArray(video.substreams) && video.substreams[0] ? finite(video.substreams[0].width) : null,
            height: Array.isArray(video.substreams) && video.substreams[0] ? finite(video.substreams[0].height) : null,
            suspended: video.suspended === true,
            transportRtt: transportRtt, transportSig: transportSig,
        };
    }

    function updateProgress(rec, stats) {
        var now = Date.now();
        // Idade do transporte e comum as duas direcoes e vive fora de
        // rec.progress (que e trocado inteiro se a direcao muda). So avanca
        // quando rtt/packets/receiverReports realmente mudam -- nao com o
        // simples fato de a amostra ter rodado de novo.
        var transportHa = -1;
        if (stats.transportSig !== null && typeof stats.transportSig !== 'undefined') {
            if (typeof rec.transportSig !== 'string' || rec.transportSig !== stats.transportSig) {
                rec.transportSig = stats.transportSig;
                rec.transportAt = now;
            }
            transportHa = now - (rec.transportAt || now);
        }
        if (stats.direction === 'inbound') {
            if (!rec.progress || rec.progress.direction !== 'inbound') {
                rec.progress = { direction: 'inbound', videoValue: null, videoAt: rec.createdAt };
            }
            var videoValue = stats.framesDecoded;
            if (videoValue === null) videoValue = stats.bytesReceived;
            if (videoValue === null) videoValue = stats.packetsReceived;
            if (stats.videoPresent && ((videoValue !== null && videoValue > (rec.progress.videoValue || 0)) ||
                (stats.decodeFrameRate !== null && stats.decodeFrameRate > 0) ||
                (stats.renderFrameRate !== null && stats.renderFrameRate > 0))) rec.progress.videoAt = now;
            rec.progress.videoValue = videoValue;
            return {
                statsOk: true, direction: 'inbound', videoPresent: stats.videoPresent,
                framesDecoded: stats.framesDecoded,
                decodeFrameRate: stats.decodeFrameRate,
                renderFrameRate: stats.renderFrameRate,
                bytesReceived: stats.bytesReceived,
                packetsReceived: stats.packetsReceived,
                mediaBitrate: stats.mediaBitrate,
                width: stats.width,
                height: stats.height,
                videoHa: now - rec.progress.videoAt,
                transportRtt: stats.transportRtt,
                transportHa: transportHa,
                sampleHa: 0,
            };
        }
        if (!rec.progress || rec.progress.direction !== 'outbound') {
            rec.progress = {
                direction: 'outbound',
                inputValue: stats.captureFrames,
                outputValue: stats.framesEncoded,
                inputAt: now,
                outputAt: now,
            };
        } else {
            if ((stats.captureFrames !== null && stats.captureFrames !== rec.progress.inputValue) ||
                (stats.inputFrameRate !== null && stats.inputFrameRate > 0)) rec.progress.inputAt = now;
            if (stats.framesEncoded !== rec.progress.outputValue ||
                (stats.encodeFrameRate !== null && stats.encodeFrameRate > 0)) rec.progress.outputAt = now;
            rec.progress.inputValue = stats.captureFrames;
            rec.progress.outputValue = stats.framesEncoded;
        }
        return {
            statsOk: true, direction: 'outbound', videoPresent: true,
            captureFrames: stats.captureFrames,
            framesEncoded: stats.framesEncoded,
            inputFrameRate: stats.inputFrameRate,
            encodeFrameRate: stats.encodeFrameRate,
            mediaBitrate: stats.mediaBitrate,
            targetMediaBitrate: stats.targetMediaBitrate,
            width: stats.width,
            height: stats.height,
            suspended: stats.suspended,
            entradaHa: now - rec.progress.inputAt,
            saidaHa: now - rec.progress.outputAt,
            transportRtt: stats.transportRtt,
            transportHa: transportHa,
            sampleHa: 0,
        };
    }

    // A chamada de fonte serve apenas para classificar o papel da conexao como
    // transmissor. Nao guardamos sourceId, callbacks nem opcoes: replay/clear
    // nao curou receiver ausente e clearDesktopSource removeu o video ao vivo.
    function hookDesktopSource(rec) {
        if (!rec || !rec.conn || rec.desktopHooked) return;
        rec.desktopHooked = true;
        var setters = ['setDesktopSource', 'setDesktopSourceWithOptions'];
        for (var si = 0; si < setters.length; si++) {
            (function (name) {
                var original;
                try { original = rec.conn[name]; } catch (e) { return; }
                if (typeof original !== 'function') return;
                try {
                    rec.conn[name] = function () {
                        var result = original.apply(this, arguments);
                        rec.isDesktopSource = true;
                        state.desktopSourceEpoch++;
                        state.desktopSource = {
                            rec: rec,
                            method: name,
                            active: true,
                            configuredAt: Date.now(),
                            epoch: state.desktopSourceEpoch,
                        };
                        return result;
                    };
                } catch (e) { }
            })(setters[si]);
        }
        try {
            var originalClear = rec.conn.clearDesktopSource;
            if (typeof originalClear === 'function') {
                rec.conn.clearDesktopSource = function () {
                    var result = originalClear.apply(this, arguments);
                    if (state.desktopSource && state.desktopSource.rec === rec) {
                        state.desktopSource.active = false;
                    }
                    return result;
                };
            }
        } catch (e) { }
    }

    function registerConnection(kind, creator, options, conn) {
        if (!conn || (typeof conn !== 'object' && typeof conn !== 'function')) return conn;
        // O cliente usa createOwnStream... apenas para quem TRANSMITE. Quem
        // assiste usa createVoice... mesmo com context=stream. O campo
        // estrutural streamUserId existe nas duas variantes de stream e nao
        // existe na voice default; inspecionamos apenas a presenca, nunca o ID.
        var isStream = kind === 'stream';
        try {
            if (!isStream && options && typeof options === 'object' &&
                Object.prototype.hasOwnProperty.call(options, 'streamUserId')) isStream = true;
        } catch (e) { }
        if (isStream) kind = 'stream';
        var existing = state.seen.get(conn);
        if (existing) {
            if (kind === 'stream') existing.kind = 'stream';
            return conn;
        }
        var rec = {
            id: state.nextId++,
            kind: kind,
            creator: creator,
            createdAt: Date.now(),
            destroyedAt: 0,
            optionShape: shape(options, 0, new WeakSet()),
            conn: conn,
        };
        state.seen.set(conn, rec);
        state.connections.push(rec);
        if (state.connections.length > 24) state.connections.shift();
        hookDesktopSource(rec);
        try {
            if (typeof conn.destroy === 'function') {
                var originalDestroy = conn.destroy;
                conn.destroy = function () {
                    rec.destroyedAt = Date.now();
                    if (state.desktopSource && state.desktopSource.rec === rec) {
                        state.desktopSource.active = false;
                    }
                    if (rec.kind === 'stream') {
                        var role = rec.isDesktopSource ? 'sender' : 'viewer';
                        if (state.demands && state.demands[role]) {
                            state.demands[role].active = false;
                            state.demands[role].changedAt = Date.now();
                        }
                    }
                    return originalDestroy.apply(this, arguments);
                };
            }
        } catch (e) { }
        return conn;
    }

    function hookVoice(voice) {
        if (!voice || (typeof voice !== 'object' && typeof voice !== 'function')) return voice;
        if (state.modules.has(voice)) return voice;
        state.modules.add(voice);
        var creators = [
            ['createVoiceConnectionWithOptions', 'voice'],
            ['createOwnStreamConnectionWithOptions', 'stream'],
        ];
        for (var i = 0; i < creators.length; i++) {
            (function (name, kind) {
                var original;
                try { original = voice[name]; } catch (e) { return; }
                if (typeof original !== 'function') return;
                voice[name] = function () {
                    state.pendingKind = kind;
                    var conn;
                    try { conn = original.apply(this, arguments); }
                    finally { state.pendingKind = null; }
                    return registerConnection(kind, name, arguments[1], conn);
                };
            })(creators[i][0], creators[i][1]);
        }
        // Backup para clientes que guardaram a referencia do factory antes do
        // nosso hook: o factory do index.js consulta VoiceEngine.VoiceConnection
        // dinamicamente ao criar uma conexao nova. Quando a chamada veio por um
        // factory ja envolvido, pendingKind evita registrar o objeto nativo e o
        // wrapper publico duas vezes; o retorno publico e registrado logo acima.
        try {
            var OriginalVoiceConnection = voice.VoiceConnection;
            if (typeof OriginalVoiceConnection === 'function') {
                function GoliveVoiceConnection() {
                    var args = Array.prototype.slice.call(arguments);
                    var instance = Reflect.construct(OriginalVoiceConnection, args, OriginalVoiceConnection);
                    if (!state.pendingKind) registerConnection('unknown', 'VoiceConnection', args[1], instance);
                    return instance;
                }
                Object.setPrototypeOf(GoliveVoiceConnection, OriginalVoiceConnection);
                GoliveVoiceConnection.prototype = OriginalVoiceConnection.prototype;
                voice.VoiceConnection = GoliveVoiceConnection;
            }
        } catch (e) { }
        state.voiceHooked = true;
        return voice;
    }

    function installNativeHook() {
        if (state.installed) return;
        var nativeModules;
        try { nativeModules = window.DiscordNative && window.DiscordNative.nativeModules; } catch (e) { }
        if (!nativeModules || typeof nativeModules.requireModule !== 'function') {
            if (state.retry++ < 200) setTimeout(installNativeHook, 25);
            return;
        }
        try {
            var originalRequire = nativeModules.requireModule;
            nativeModules.requireModule = function () {
                var loaded = originalRequire.apply(this, arguments);
                if (arguments[0] === 'discord_voice') return hookVoice(loaded);
                return loaded;
            };
            state.installed = true;
            // O preload original do Discord pode ter exigido o addon antes dos
            // preloads de sessao. Buscar o modulo aqui devolve a instancia em
            // cache e permite envolve-la antes de a interface criar a call.
            try { hookVoice(originalRequire.call(nativeModules, 'discord_voice')); } catch (e) { }
        } catch (e) {
            state.installed = false;
        }
    }

    function noteDemand(args) {
        try {
            var joined = Array.prototype.map.call(args, function (value) {
                return typeof value === 'string' ? value : '';
            }).join(' ');
            // Sender: pedido REMOTO para o nosso outbound. Viewer: pedido
            // LOCAL da tela de Go Live para o inbound. Misturar os dois torna
            // o viewer falsamente sem demanda, pois seu outbound fica em zero.
            var marker = 'Go Live Media sink wants:';
            var role = 'viewer';
            var at = joined.indexOf(marker);
            if (at < 0) {
                marker = 'Remote media sink wants:';
                role = 'sender';
                at = joined.indexOf(marker);
            }
            if (at < 0) return;
            var payload = JSON.parse(joined.slice(at + marker.length).trim());
            var positive = false;
            function walk(value) {
                if (positive || value === null || value === undefined) return;
                if (typeof value === 'number') { if (value > 0) positive = true; return; }
                if (typeof value === 'object') {
                    var values = Object.values(value);
                    for (var i = 0; i < values.length; i++) walk(values[i]);
                }
            }
            walk(payload && payload.pixelCounts);
            if (!positive && payload && typeof payload === 'object') {
                var entries = Object.entries(payload);
                for (var i = 0; i < entries.length; i++) {
                    var key = entries[i][0], value = entries[i][1];
                    if (key !== 'any' && key !== 'pixelCounts' && typeof value === 'number' && value > 0) positive = true;
                }
            }
            var now = Date.now();
            var demand = state.demands[role];
            if (!demand.known || demand.active !== positive) {
                demand.changedAt = now;
                // Uma transicao para demanda positiva e uma nova intencao de
                // assistir/transmitir. O main usa somente este contador local
                // para renovar o teto de uma nova Live, nunca payload ou ID.
                if (positive) demand.epoch++;
            }
            demand.known = true;
            demand.active = positive;
            if (positive) demand.at = now;
        } catch (e) { }
    }

    ['log', 'info', 'debug'].forEach(function (method) {
        try {
            var original = console[method];
            if (typeof original !== 'function') return;
            console[method] = function () {
                noteDemand(arguments);
                return original.apply(this, arguments);
            };
        } catch (e) { }
    });

    function sample(rec) {
        return new Promise(function (resolve) {
            if (rec.destroyedAt > 0 || !rec.conn) return resolve({ statsOk: false, reason: 'destruida' });
            if (rec.kind !== 'stream') return resolve({ statsOk: false, reason: 'tipo' });
            var method = null;
            var filtered = false;
            if (typeof rec.conn.getFilteredStats === 'function') {
                method = rec.conn.getFilteredStats;
                filtered = true;
            } else if (typeof rec.conn.getStats === 'function') {
                // Compatibilidade com addons antigos. O atual sempre segue o
                // ramo filtrado acima, evitando o metodo stale do index.js.
                method = rec.conn.getStats;
            }
            if (!method) return resolve({ statsOk: false, reason: 'sem-metodo' });
            var done = false;
            var timer = null;
            function finish(raw) {
                if (done) return;
                done = true;
                if (timer !== null) clearTimeout(timer);
                var normalized = normalizeStats(raw, rec.isDesktopSource ? 'sender' : 'viewer');
                if (!normalized.ok) {
                    resolve({ statsOk: false, reason: normalized.reason, statsShape: normalized.shape });
                    return;
                }
                resolve(updateProgress(rec, normalized));
            }
            timer = setTimeout(function () { finish({}); }, 2500);
            try {
                var returned = filtered
                    ? method.call(rec.conn, 7, function (raw) { finish(raw); })
                    : method.call(rec.conn, function (raw) { finish(raw); });
                if (returned && typeof returned.then === 'function') returned.then(finish, function () { finish({}); });
            } catch (e) { finish({}); return; }
        });
    }

    function demandSummary(demand, now) {
        return {
            known: demand.known,
            active: demand.active,
            demandHa: demand.at > 0 ? now - demand.at : -1,
            changedHa: demand.changedAt > 0 ? now - demand.changedAt : -1,
            epoch: demand.epoch,
        };
    }

    window.__goliveVoiceDemandaResumo = function () {
        var now = Date.now();
        return {
            sender: demandSummary(state.demands.sender, now),
            viewer: demandSummary(state.demands.viewer, now),
        };
    };

    window.__goliveVoiceResumo = function () {
        var now = Date.now();
        return Promise.all(state.connections.map(function (rec) {
            return sample(rec).then(function (sampled) {
                return {
                    id: rec.id,
                    kind: rec.kind,
                    creator: rec.creator,
                    role: rec.isDesktopSource ? 'sender' : 'viewer',
                    createdHa: now - rec.createdAt,
                    destroyed: rec.destroyedAt > 0,
                    optionShape: rec.optionShape,
                    stats: sampled,
                };
            });
        })).then(function (connections) {
            var source = state.desktopSource;
            var sourceReady = !!(source && source.active && source.rec &&
                !source.rec.destroyedAt);
            return {
                installed: state.installed,
                voiceHooked: state.voiceHooked,
                instanceId: state.instanceId,
                demands: {
                    sender: demandSummary(state.demands.sender, Date.now()),
                    viewer: demandSummary(state.demands.viewer, Date.now()),
                },
                sourceReady: sourceReady,
                sourceMethod: sourceReady ? source.method : '',
                sourceKind: sourceReady ? source.rec.kind : '',
                sourceEpoch: sourceReady ? source.epoch : 0,
                connections: connections,
            };
        });
    };

    installNativeHook();
}
const SHIM_VOICE_SRC = '(' + instalarVoiceShim.toString() + ')();';
// === voice shim: fim ===

// === worker shim (beta 11, issues #164/#163) ===
// O gateway e o RTC do Discord nascem em Dedicated Workers. Preload de sessao
// aceita apenas frame/service-worker e nao cobre esse contexto; envolver
// window.Worker tambem nao e seguro (isolamento de mundo, XHR sincrono e module
// workers). Por isso o main pausa cada target novo via CDP Target.setAutoAttach,
// injeta este codigo antes do primeiro byte do bundle e sempre libera o target.
//
// Este shim roda no escopo do worker (self, sem window). O main consulta e age
// diretamente no sessionId CDP exato; nenhum dado/controle atravessa o renderer.
function instalarWorkerShim() {
    if (typeof self === 'undefined' || self.__goliveWorkerShim) return;
    self.__goliveWorkerShim = true;

    var workerId = (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
    var geracao = 0;
    var opCounts = {};
    var cliEnvios = [];
    var gw = {
        estado: 'nenhum', ws: null, srvEm: 0, cliEm: 0, abertoEm: 0,
        srvFrames: 0, srvBytes: 0, srvBytesDesdeAtividade: 0,
        cliEnvios: 0, dispatches: 0, dispatchEm: 0, intentEm: 0,
        activityEm: 0, op4Em: 0, subs: 0,
    };
    var midia = new Set();
    var midiaMeta = new Map();
    var midiaSeq = 0;
    var midiaAbertaEm = 0;
    var midiaFechouEm = 0;
    var pcs = new Set();

    function idade(agora, em) { return em > 0 ? agora - em : -1; }
    function resumo() {
        var agora = Date.now();
        return {
            origem: 'worker', workerId: workerId,
            geracao: geracao, estado: gw.estado,
            srvHa: idade(agora, gw.srvEm), cliHa: idade(agora, gw.cliEm),
            abertoHa: idade(agora, gw.abertoEm),
            srvFrames: gw.srvFrames, srvBytes: gw.srvBytes,
            srvBytesDesdeAtividade: gw.srvBytesDesdeAtividade,
            cliEnvios: gw.cliEnvios, dispatches: gw.dispatches,
            dispatchHa: idade(agora, gw.dispatchEm),
            intentHa: idade(agora, gw.intentEm),
            activityHa: idade(agora, gw.activityEm),
            op4Ha: idade(agora, gw.op4Em), subs: gw.subs,
            opCounts: Object.assign({}, opCounts), infladorOk: false,
            midia: midia.size, midiaAberta: midia.size > 0,
            midiaOpenHa: idade(agora, midiaAbertaEm),
            midiaCloseHa: idade(agora, midiaFechouEm),
            midiaSockets: Array.from(midia).map(function (ws) {
                var meta = midiaMeta.get(ws);
                if (!meta) return null;
                return {
                    id: meta.id, createdHa: agora - meta.createdAt,
                    openHa: meta.openedAt ? agora - meta.openedAt : -1,
                    readyState: ws.readyState,
                    kind: meta.kind || '',
                };
            }).filter(function (item) { return item !== null; }),
            pcs: pcs.size,
        };
    }
    self.__goliveWorkerResumo = resumo;

    function publicar(logar) {
        var atual = resumo();
        if (logar) {
            try { console.warn('GLB_WORKER_GW ' + JSON.stringify(atual)); } catch (e) { }
        }
    }

    function fecharMidia(id) {
        var alvo = null;
        midia.forEach(function (ws) {
            var meta = midiaMeta.get(ws);
            if (meta && meta.id === id) alvo = ws;
        });
        if (!alvo || alvo.readyState !== 1) return false;
        try { alvo.close(4000, 'golive-stream-revive'); return true; } catch (e) { return false; }
    }
    self.__goliveWorkerFecharMidia = fecharMidia;
    self.__goliveWorkerFecharGateway = function (geracaoEsperada) {
        if (Number(geracaoEsperada) !== geracao) return false;
        var ws = gw.ws;
        if (!ws || ws.readyState !== 1) return false;
        try { ws.close(4000, 'golive-revive'); return true; } catch (e) { return false; }
    };

    function opDeBinario(dados) {
        try {
            var u;
            if (dados instanceof ArrayBuffer) u = new Uint8Array(dados);
            else if (dados && typeof dados.byteLength === 'number') {
                u = new Uint8Array(dados.buffer, dados.byteOffset || 0, dados.byteLength);
            } else return -1;
            if (u.length < 8 || u[0] !== 131) return -1;
            var p = -1;
            if (u[1] === 104) p = 3;
            else if (u[1] === 105) p = 6;
            else if (u[1] === 116) {
                // ETF MAP_EXT do cliente atual: #{<<"op">> => inteiro, ...}.
                // Exige a chave literal como primeiro par; nao percorre termos
                // arbitrarios nem tenta adivinhar mapas fora desse formato.
                if (u.length < 15 || u[6] !== 109) return -1;
                var tamChave = (u[7] * 16777216) + (u[8] * 65536) + (u[9] * 256) + u[10];
                if (tamChave !== 2 || u[11] !== 111 || u[12] !== 112) return -1;
                p = 13;
            } else return -1;
            var op = -1;
            if (u[p] === 97) op = u[p + 1];
            else if (u[p] === 98) op = (u[p + 1] * 16777216) + (u[p + 2] * 65536) + (u[p + 3] * 256) + u[p + 4];
            return op === 1 || op === 4 || op === 14 ||
                op === 18 || op === 19 || op === 20 || op === 21 || op === 22 || op === 37 ? op : -1;
        } catch (e) { return -1; }
    }

    function registrarEnvio(agora) {
        cliEnvios.push(agora);
        while (cliEnvios.length > 0 && cliEnvios[0] < agora - 30000) cliEnvios.shift();
        if (cliEnvios.length >= 3) {
            gw.activityEm = agora;
            gw.srvBytesDesdeAtividade = 0;
        }
    }

    var OriginalWebSocket = self.WebSocket;
    if (typeof OriginalWebSocket === 'function') {
        function GoliveWorkerWebSocket(url, protocolos) {
            var ws = protocolos === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocolos);
            try {
                var alvo = String(url);
                var ehMidia = false;
                var ehGw = false;
                try { ehMidia = /(^|\.)discord\.media$/.test(new URL(alvo).hostname); } catch (e) { }
                try { ehGw = /(^|\.)gateway(-[a-z0-9-]+)?\.discord\.gg$/.test(new URL(alvo).hostname); } catch (e) { }
                if (ehMidia) {
                    var meta = { id: ++midiaSeq, createdAt: Date.now(), openedAt: 0, kind: '' };
                    midia.add(ws);
                    midiaMeta.set(ws, meta);
                    ws.addEventListener('open', function () {
                        meta.openedAt = Date.now();
                        midiaAbertaEm = meta.openedAt;
                        publicar(true);
                    });
                    ws.addEventListener('close', function () {
                        midia.delete(ws);
                        midiaMeta.delete(ws);
                        midiaFechouEm = Date.now();
                        publicar(true);
                    });
                    try {
                        var originalSend = ws.send;
                        ws.send = function (dados) {
                            try {
                                if (typeof dados === 'string' && dados.charCodeAt(0) === 123) {
                                    var p = JSON.parse(dados);
                                    if (p && p.op === 0 && p.d) {
                                        // Prove de Go Live e so o array de streams (entradas
                                        // reais de transmissao). video:true sozinho e atributo
                                        // de camera em call de voz: marca-lo como stream faria
                                        // o revive fechar o socket da chamada (issue #186).
                                        if (Array.isArray(p.d.streams) && p.d.streams.length > 0) {
                                            meta.kind = 'stream';
                                        } else if (p.d.server_id && p.d.channel_id) {
                                            meta.kind = 'voice';
                                        }
                                    }
                                }
                            } catch (e) { }
                            return originalSend.apply(this, arguments);
                        };
                        ws.addEventListener('message', function (ev) {
                            try {
                                if (typeof ev.data === 'string' && ev.data.charCodeAt(0) === 123) {
                                    var p = JSON.parse(ev.data);
                                    // So classifica enquanto ainda nao ha prova forte (o IDENTIFY
                                    // acima, unica fonte que decide entre streams[] e
                                    // server_id+channel_id). Sem este "so se meta.kind === ''",
                                    // um op 5 (mensagem do servidor, chega varias vezes durante a
                                    // vida do socket) podia REBAIXAR um socket ja provado 'stream'
                                    // de volta para 'voice' -- socketMidiaDaStream() exclui todo
                                    // socket 'voice' do close direcionado, entao o socket certo
                                    // ficava permanentemente inelegivel para a recuperacao RTC,
                                    // sem nunca ser reavaliado. Prova forte, uma vez estabelecida,
                                    // nao pode ser desfeita por um sinal mais fraco e recorrente.
                                    if (meta.kind === '') {
                                        if (p && (p.op === 12 || p.op === 15)) meta.kind = 'stream';
                                        else if (p && p.op === 5) meta.kind = 'voice';
                                    }
                                }
                            } catch (e) { }
                        });
                    } catch (e) { }
                }
                if (ehGw) {
                    var minhaGeracao = ++geracao;
                    gw.estado = 'conectando';
                    gw.ws = ws;
                    gw.srvEm = 0; gw.cliEm = 0; gw.abertoEm = 0;
                    gw.srvFrames = 0; gw.srvBytes = 0; gw.srvBytesDesdeAtividade = 0;
                    gw.cliEnvios = 0; gw.dispatches = 0; gw.dispatchEm = 0;
                    gw.intentEm = 0; gw.activityEm = 0; gw.op4Em = 0; gw.subs = 0;
                    opCounts = {};
                    cliEnvios = [];
                    function atual() { return geracao === minhaGeracao && gw.ws === ws; }
                    ws.addEventListener('open', function () {
                        if (!atual()) return;
                        gw.estado = 'aberta';
                        gw.abertoEm = Date.now();
                        publicar(true);
                    });
                    ws.addEventListener('close', function () {
                        if (!atual()) return;
                        gw.estado = 'fechada';
                        gw.ws = null;
                        publicar(true);
                    });
                    ws.addEventListener('message', function (ev) {
                        if (!atual()) return;
                        var agora = Date.now();
                        var pedaco = ev.data;
                        var tamanho = 0;
                        gw.srvEm = agora;
                        gw.srvFrames++;
                        if (typeof pedaco === 'string') {
                            tamanho = pedaco.length;
                            try {
                                var pacote = JSON.parse(pedaco);
                                if (pacote && pacote.op === 0) {
                                    gw.dispatches++;
                                    gw.dispatchEm = agora;
                                }
                            } catch (e) { }
                        } else if (pedaco && typeof pedaco.size === 'number') tamanho = pedaco.size;
                        else if (pedaco && typeof pedaco.byteLength === 'number') tamanho = pedaco.byteLength;
                        gw.srvBytes += tamanho;
                        gw.srvBytesDesdeAtividade += tamanho;
                    });
                    var enviar = ws.send.bind(ws);
                    ws.send = function (dados) {
                        if (atual()) {
                            var agora = Date.now();
                            var op = -1;
                            gw.cliEm = agora;
                            gw.cliEnvios++;
                            registrarEnvio(agora);
                            if (typeof dados === 'string') {
                                try { op = JSON.parse(dados).op; } catch (e) { }
                            } else if (dados && (dados instanceof ArrayBuffer || typeof dados.byteLength === 'number')) {
                                op = opDeBinario(dados);
                            } else if (dados && typeof dados.arrayBuffer === 'function') {
                                dados.arrayBuffer().then(function (ab) {
                                    var opAsync = opDeBinario(ab);
                                    if (atual() && (opAsync === 4 || opAsync === 18 || opAsync === 20)) {
                                        gw.op4Em = Date.now();
                                        gw.intentEm = gw.op4Em;
                                        publicar(false);
                                    }
                                }, function () { });
                            }
                            if (typeof op === 'number' && op >= 0) {
                                opCounts[op] = (opCounts[op] || 0) + 1;
                                if (op !== 1 && op !== 19 && op !== 21) gw.intentEm = agora;
                                if (op === 4 || op === 18 || op === 20) gw.op4Em = agora;
                                if (op === 14 || op === 37) gw.subs++;
                            }
                        }
                        return enviar(dados);
                    };
                    publicar(false);
                }
            } catch (e) { }
            return ws;
        }
        GoliveWorkerWebSocket.prototype = OriginalWebSocket.prototype;
        GoliveWorkerWebSocket.CONNECTING = 0; GoliveWorkerWebSocket.OPEN = 1;
        GoliveWorkerWebSocket.CLOSING = 2; GoliveWorkerWebSocket.CLOSED = 3;
        self.WebSocket = GoliveWorkerWebSocket;
    }

    var OriginalRTCPeerConnection = self.RTCPeerConnection;
    if (typeof OriginalRTCPeerConnection === 'function') {
        function GoliveWorkerRTCPeerConnection(cfg, cert) {
            var pc = new OriginalRTCPeerConnection(cfg, cert);
            try {
                pcs.add(pc);
                if (typeof pc.close === 'function') {
                    var fechar = pc.close.bind(pc);
                    pc.close = function () { pcs.delete(pc); return fechar(); };
                }
                publicar(false);
            } catch (e) { }
            return pc;
        }
        GoliveWorkerRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
        self.RTCPeerConnection = GoliveWorkerRTCPeerConnection;
    }

    publicar(true);
}
const SHIM_WORKER_SRC = '(' + instalarWorkerShim.toString() + ')();';

// === gateway: probe no renderer + pill + REVIVE automatico (issues #145/#149/#153) ===
// A beta.3 provou com logs (issues #149/#150) que o zumbi de aplicacao e
// INVISIVEL para a rede: durante os vaos (416s e 713s) o tunel seguiu carregando
// heartbeats — sessao protocolarmente viva, dados nao fluem. A #153 trouxe o
// ground truth do probe: ws aberta, heartbeats dos DOIS lados (srv_ha=1s,
// cli_ha=0s) e o usuario em loading infinito — o servidor ACEITA heartbeat mas
// nao entrega dispatch. Com o shim descomprimindo o servidor (DecompressionStream
// no renderer), dispatch deixou de ser indistinguivel de heartbeat e o caso
// "protocolo vivo, dados mortos" virou DETECTAVEL. Consequencias do desenho:
// 1. A cura SEM reload existe: fechar o ws com close(4000) — o mesmo codigo que o
//    proprio cliente usa ao receber op 7 (RECONNECT) — faz ele renascer sozinho
//    com RESUME, sem Ctrl+R. __goliveGwFechar() expoe isso ao main.
// 2. A escada de revive e automatica mas conservadora: nivel 1 = close 4000;
//    nivel 2 = reload (a cura que sempre funciona). NUNCA com midia aberta ou
//    recente (regra de MIDIA_RECENTE_MS/§6 — reconexao de gateway mata o video
//    da live). Teto de tentativas e cooldown; estourou, volta a ser ambiental
//    (banner + pill, decisao do usuario).
// 3. O alarme "silente" segue re-escopado: servidor INTEIRO calado (>3min sem
//    nenhum frame, nem ACK) e morte de rede de verdade — banner only, o cliente
//    reconecta sozinho em instantes.

// Shim do renderer: roda ANTES do bundle do Discord (CDP
// addScriptToEvaluateOnNewDocument, unico ponto sem corrida), no main world.
// Envolve o WebSocket para: (a) contar frames/bytes dos dois lados; (b) detectar
// ATIVIDADE do cliente e dispatch do servidor; (c) rastrear websockets de midia
// abertos (o pill usa para se esconder em call/transmissao).
//
// AGNOSTICO DE PROTOCOLO (issues #154/#156/#158, beta 6): o cliente atual do
// Discord manda frames BINARIOS (etf) — JSON.parse falha em todo send, o
// histograma de ops fica vazio (ops={} com cli_ha=1s no log da #156) e o
// inflador zlib quebrava para sempre ("sem decompress" em toda sessao), o que
// deixava a cura automatica como no-op (revives=0 no carregamento infinito).
// Entao o shim v3 nao depende mais de decodificar o payload:
// - atividade = BURST de envios (3+ em 30s) — heartbeat vem a cada ~41s, entao
//   burst so acontece com o usuario pedindo algo; funciona em JSON ou binario;
// - inflador RESINCRONIZA ate 3x por geracao em vez de morrer, e texto direto
//   (encoding=json) e processado sem inflate;
// - VOLUME de resposta: servidor saudavel responde ao pedido com centenas de
//   bytes; o zumbi devolve so o baseline de heartbeat (bytes) — sinal que nao
//   depende de saber o encoding do payload.
const SHIM_GATEWAY_SRC = "(function(){" +
    "  if (window.__goliveGwShim) return;" +
    "  window.__goliveGwShim = true;" +
    "  var midia = new Set();" +
    "  var midiaMeta = new Map();" +
    "  var midiaSeq = 0;" +
    "  var geracao = 0;" +
    "  var opCounts = {};" +
    "  var gw = { estado: 'nenhum', srvEm: 0, cliEm: 0, op1Em: 0, subs: 0, srvFrames: 0," +
    "    dispatches: 0, dispatchEm: 0, intentEm: 0, abertoEm: 0, ws: null," +
    "    activityEm: 0, srvBytes: 0, srvBytesDesdeAtividade: 0, op4Em: 0 };" +
    "  var inflador = null;" +
    "  var infladorToken = 0;" +
    "  var infladorResyncs = 0;" +
    "  var cliEnvios = [];" +
    "  var textoPendente = '';" +
    "  var midiaAbertaEm = 0, midiaFechouEm = 0;" +
    // Reassiste somente a Live que ESTAVA visivel quando o gateway caiu. Isto
    // diferencia uma perda real de sinalizacao do usuario que escolheu parar
    // de assistir; sem esse snapshot local, nunca clicamos em nada.
    "  var reassistirPendenteEm = 0, reassistirTentou = false, reassistirCanceladaPeloUsuario = false;" +
    // O snapshot da Live e feito no fechamento do gateway, mas a pessoa pode
    // decidir parar de assistir durante a reconexao. Qualquer gesto real dela
    // dentro dessa curta janela vence a automacao. O clique sintetico abaixo
    // (button.click) nao e trusted, portanto nao cancela a propria cura.
    "  function cancelarReassistirPorUsuario(ev) { if (reassistirPendenteEm && ev && ev.isTrusted) { reassistirPendenteEm=0; reassistirTentou=true; reassistirCanceladaPeloUsuario=true; } }" +
    "  window.addEventListener('pointerdown', cancelarReassistirPorUsuario, true);" +
    "  window.addEventListener('keydown', cancelarReassistirPorUsuario, true);" +
    "  window.__goliveGwResumo = function () {" +
    "    var agora = Date.now();" +
    "    return { estado: gw.estado," +
    "      srvHa: gw.srvEm ? agora - gw.srvEm : -1," +
    "      cliHa: gw.cliEm ? agora - gw.cliEm : -1," +
    "      subs: gw.subs, srvFrames: gw.srvFrames," +
    "      dispatches: gw.dispatches," +
    "      dispatchHa: gw.dispatchEm ? agora - gw.dispatchEm : -1," +
    "      intentHa: gw.intentEm ? agora - gw.intentEm : -1," +
    "      activityHa: gw.activityEm ? agora - gw.activityEm : -1," +
    "      op4Ha: gw.op4Em ? agora - gw.op4Em : -1," +
    "      midiaOpenHa: midiaAbertaEm ? agora - midiaAbertaEm : -1," +
    "      midiaCloseHa: midiaFechouEm ? agora - midiaFechouEm : -1," +
    "      abertoHa: gw.abertoEm ? agora - gw.abertoEm : -1," +
    "      geracao: geracao," +
    "      opCounts: opCounts," +
    "      srvBytes: gw.srvBytes," +
    "      srvBytesDesdeAtividade: gw.srvBytesDesdeAtividade," +
    "      midiaAberta: midia.size > 0," +
    "      midiaSockets: Array.from(midia).map(function(w){" +
    "        var m = midiaMeta.get(w), agora2 = Date.now();" +
    "        return m ? { id:m.id, createdHa:agora2-m.createdAt," +
    "          openHa:m.openedAt ? agora2-m.openedAt : -1, readyState:w.readyState, kind:m.kind||'' } : null;" +
    "      }).filter(function(m){return !!m;})," +
    "      infladorOk: !!inflador };" +
    "  };" +
    "  window.__goliveMidiaAberta = function () { return midia.size > 0; };" +
    "  window.__goliveMidiaFecharId = function (id) {" +
    "    var alvo = null;" +
    "    midia.forEach(function (w) { var m=midiaMeta.get(w); if(m && m.id===id) alvo=w; });" +
    "    if (!alvo || alvo.readyState !== 1) return { ok:false, id:id, reason:'ausente' };" +
    "    try { alvo.close(4000, 'golive-stream-revive'); return { ok:true, id:id }; }" +
    "    catch (e) { return { ok:false, id:id, reason:'close' }; }" +
    "  };" +
    "  window.__goliveGwFechar = function () {" +
    "    var ws = gw.ws;" +
    "    if (!ws || ws.readyState !== 1) return false;" +
    "    try { ws.close(4000, 'golive-revive'); return true; } catch (e) { return false; }" +
    "  };" +
    "  function videoEstavaSaudavel() {" +
    "    try { var v=window.__goliveVideoResumo?window.__goliveVideoResumo():null;" +
    "      return !!(v&&v.visible===true&&v.frameHa>=0&&v.frameHa<=30000); } catch (e) { return false; }" +
    "  }" +
    "  function botaoReassistir() {" +
    "    var nomes=['Assista à transmissão','Watch Stream']; var lista=[];" +
    "    try { lista=Array.prototype.slice.call(document.querySelectorAll('button')); } catch (e) { return null; }" +
    "    for (var i=0;i<lista.length;i++) { var b=lista[i], texto=(b.textContent||'').trim();" +
    "      if (nomes.indexOf(texto)>=0&&b.disabled!==true&&b.offsetParent!==null) return b; }" +
    "    return null;" +
    "  }" +
    // Chamada pelo processo principal apos o gateway voltar. Uma tentativa e
    // suficiente: se o Discord nao recriar a stream, o banner manual continua
    // sendo a saida segura; repetir cliques viraria loop e violaria a intencao.
    "  window.__goliveReassistirAposGateway = function () {" +
    "    var agora=Date.now();" +
    "    if (reassistirCanceladaPeloUsuario) { reassistirCanceladaPeloUsuario=false; return 'cancelada_usuario'; }" +
    "    if (!reassistirPendenteEm) return 'nenhuma';" +
    "    if (agora-reassistirPendenteEm>45000) { reassistirPendenteEm=0; return 'expirada'; }" +
    // O tile antigo pode sobreviver alguns segundos ao READY. Enquanto ainda
    // ha frames, espera em vez de concluir cedo: se o Discord removê-lo logo
    // depois, a mesma janela ainda pode encontrar o botao e reassistir.
    "    if (videoEstavaSaudavel()) return 'aguardar';" +
    "    if (reassistirTentou) { reassistirPendenteEm=0; return 'tentada'; }" +
    "    var botao=botaoReassistir(); if (!botao) return 'aguardar';" +
    "    reassistirTentou=true; reassistirPendenteEm=0;" +
    "    try { botao.click(); return 'clicou'; } catch (e) { return 'falhou'; }" +
    "  };" +
    // ATIVIDADE POR GAP: 3+ envios em 30s = usuario pedindo algo. Heartbeats sao
    // ~41s apart, entao 2 heartbeats + uma presenca solta nao fecha 3 em 30s.
    "  function registrarEnvio(agora) {" +
    "    cliEnvios.push(agora);" +
    "    while (cliEnvios.length > 0 && cliEnvios[0] < agora - 30_000) cliEnvios.shift();" +
    "    if (cliEnvios.length >= 3) {" +
    "      gw.activityEm = agora;" +
    "      gw.srvBytesDesdeAtividade = 0;" +
    "    }" +
    "  }" +
    // SNIFF do op em frames BINARIOS. Clientes antigos mandavam 131+tupla; o
    // Discord atual manda ETF MAP_EXT #{<<"op">> => inteiro, ...}. Interessa o
    // inicio de voz (4), criar Live (18) e assistir Live (20). Parse defensivo:
    // formato estranho devolve -1, sem varrer payload nem produzir falso op.
    "  function opDeBinario(dados) {" +
    "    try {" +
    "      var u;" +
    "      if (dados instanceof ArrayBuffer) { u = new Uint8Array(dados); }" +
    "      else if (typeof dados.byteLength === 'number') { u = new Uint8Array(dados.buffer, dados.byteOffset || 0, dados.byteLength); }" +
    "      else { return -1; }" +
    "      if (u.length < 8 || u[0] !== 131) return -1;" +
    "      var p = -1;" +
    "      if (u[1] === 104) { p = 3; }" +
    "      else if (u[1] === 105) { p = 6; }" +
    "      else if (u[1] === 116) {" +
    "        if (u.length < 15 || u[6] !== 109) return -1;" +
    "        var z = (u[7] * 16777216) + (u[8] * 65536) + (u[9] * 256) + u[10];" +
    "        if (z !== 2 || u[11] !== 111 || u[12] !== 112) return -1;" +
    "        p = 13;" +
    "      } else { return -1; }" +
    "      var op = -1;" +
    "      if (u[p] === 97) { op = u[p + 1]; }" +
    "      else if (u[p] === 98) { op = (u[p + 1] * 16777216) + (u[p + 2] * 65536) + (u[p + 3] * 256) + u[p + 4]; }" +
    "      if (op !== 1 && op !== 4 && op !== 14 && op !== 18 && op !== 19 &&" +
    "          op !== 20 && op !== 21 && op !== 22 && op !== 37) return -1;" +
    "      return op;" +
    "    } catch (e) { return -1; }" +
    "  }" +
    // Conta dispatch (op 0) em payload decodificavel (texto direto ou inflado do
    // zlib-stream). Fatia payloads completos com contador de chaves respeitando
    // strings; o resto parcial fica para o proximo pedaco. Lixo nao-JSON so
    // acumula ate o teto e e descartado (nunca cresce eterno).
    "  function processarTextoPendente() {" +
    "    var s = textoPendente;" +
    "    if (s.length > 2_000_000) { textoPendente = ''; return; }" +
    "    var inicio = 0, prof = 0, emStr = false, esc = false;" +
    "    for (var i = 0; i < s.length; i++) {" +
    "      var c = s[i];" +
    "      if (emStr) {" +
    "        if (esc) esc = false;" +
    "        else if (c === '\\\\') esc = true;" +
    "        else if (c === '\"') emStr = false;" +
    "        continue;" +
    "      }" +
    "      if (c === '\"') { emStr = true; continue; }" +
    "      if (c === '{') prof++;" +
    "      else if (c === '}') {" +
    "        prof--;" +
    "        if (prof === 0) {" +
    "          try {" +
    "            var p = JSON.parse(s.slice(inicio, i + 1));" +
    "            if (p && typeof p === 'object' && p.op === 0) { gw.dispatches++; gw.dispatchEm = Date.now(); }" +
    "          } catch (e) { }" +
    "          inicio = i + 1;" +
    "        } else if (prof < 0) { prof = 0; inicio = i + 1; }" +
    "      }" +
    "    }" +
    "    textoPendente = inicio > 0 ? s.slice(inicio) : s;" +
    "  }" +
    // Fluxo zlib continuo (zlib-stream): um DecompressionStream por tentativa. Em
    // erro NAO morre mais para sempre (a #156 passou a sessao inteira com "sem
    // decompress"): resincroniza com stream novo ate 3x por geracao — cobre
    // dessincronia de fluxo continuo E servidores que mandam cada payload como
    // stream proprio. Exaustou, degrada para os contadores crus.
    "  function iniciarInflador() {" +
    "    if (typeof DecompressionStream === 'undefined') { inflador = null; return; }" +
    "    try {" +
    "      var ds = new DecompressionStream('deflate');" +
    "      var decod = new TextDecoder();" +
    "      var token = ++infladorToken;" +
    "      inflador = { writer: ds.writable.getWriter() };" +
    "      var reader = ds.readable.getReader();" +
    "      (function passo() {" +
    "        reader.read().then(function (r) {" +
    "          if (r.done || token !== infladorToken) return;" +
    "          textoPendente += decod.decode(r.value, { stream: true });" +
    "          try { processarTextoPendente(); } catch (e) { }" +
    "          passo();" +
    "        }, function () { if (token === infladorToken) falhaInflador(token); });" +
    "      })();" +
    "    } catch (e) { inflador = null; }" +
    "  }" +
    "  function falhaInflador(tokenEsperado) {" +
    "    if (typeof tokenEsperado === 'number' && tokenEsperado !== infladorToken) return;" +
    "    infladorToken++;" +
    "    if (infladorResyncs < 3) { infladorResyncs++; iniciarInflador(); }" +
    "    else { inflador = null; }" +
    "  }" +
    "  function inflarBinario(pedaco, geracaoEsperada) {" +
    "    if (!inflador) return;" +
    "    if (typeof pedaco.arrayBuffer === 'function') {" +
    "      pedaco.arrayBuffer().then(function (buf) { if (geracao === geracaoEsperada) escreverInflador(buf); }, function () { if (geracao === geracaoEsperada) falhaInflador(infladorToken); });" +
    "    } else {" +
    "      escreverInflador(pedaco);" +
    "    }" +
    "  }" +
    "  function escreverInflador(bytes) {" +
    "    if (!inflador) return;" +
    "    var token = infladorToken;" +
    "    try {" +
    "      inflador.writer.write(bytes).then(null, function () { falhaInflador(token); });" +
    "    } catch (e) { falhaInflador(token); }" +
    "  }" +
    // RTC (beta 10): envolver o RTCPeerConnection para enxergar o que TOCA — o
    // audio de Go Live vem por RTC/UDP (nao pelo gateway), entao "escuto a stream
    // mas o video nao sai" so e visivel aqui dentro. getStats() separa os bytes
    // inbound por kind (audio vs video) e mostra se o usuario e quem transmite.
    "  var pcs = new Set();" +
    "  var rtc = { audioBytes: -1, videoBytes: -1, audioEm: 0, videoEm: 0, videoTrack: false, enviando: false };" +
    // O addon discord_voice pode conservar a mesma conexao nativa quando o
    // viewer sai e volta a assistir. Nesse caso seus contadores ainda podem
    // carregar frames da Live anterior e fingir que o video novo esta sano.
    // A pagina, porem, sempre anexa um MediaStream novo ao elemento DirectVideo.
    // Observamos somente uma geracao local opaca + frames realmente apresentados.
    // nunca exportamos ids de track/stream, URL ou qualquer identificador do Discord.
    "  var visualSeq = 0, visualRegistros = new WeakMap(), visualSelecionado = null;" +
    "  function visualVisivel(video) {" +
    "    try {" +
    "      if (!video || !video.isConnected || !video.srcObject) return false;" +
    "      var r = video.getBoundingClientRect(); var s = getComputedStyle(video);" +
    "      return r.width >= 32 && r.height >= 32 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;" +
    "    } catch (e) { return false; }" +
    "  }" +
    "  function vigiarVisual(video) {" +
    "    if (!video) return null;" +
    "    var rec = visualRegistros.get(video);" +
    "    if (!rec) { rec = { fonte: null, geracao: 0, anexadoEm: 0, frameEm: 0, tempo: -1, quadroArmado: false }; visualRegistros.set(video, rec); }" +
    "    var fonte = null; try { fonte = video.srcObject || null; } catch (e) { }" +
    "    if (fonte !== rec.fonte) { rec.fonte = fonte; rec.geracao = fonte ? ++visualSeq : 0; rec.anexadoEm = fonte ? Date.now() : 0; rec.frameEm = 0; rec.tempo = -1; rec.quadroArmado = false; }" +
    "    if (fonte && !rec.quadroArmado && typeof video.requestVideoFrameCallback === 'function') {" +
    "      rec.quadroArmado = true;" +
    "      var geracaoQuadro = rec.geracao; var quadro = function () {" +
    "        if (rec.geracao !== geracaoQuadro || !rec.fonte) return;" +
    "        rec.frameEm = Date.now();" +
    "        try { video.requestVideoFrameCallback(quadro); } catch (e) { rec.quadroArmado = false; }" +
    "      };" +
    "      try { video.requestVideoFrameCallback(quadro); } catch (e) { rec.quadroArmado = false; }" +
    "    }" +
    "    try { if (fonte && Number.isFinite(video.currentTime)) { var tempo = video.currentTime; if (rec.tempo >= 0 && tempo > rec.tempo) rec.frameEm = Date.now(); rec.tempo = tempo; } } catch (e) { }" +
    "    return rec;" +
    "  }" +
    "  window.__goliveVideoResumo = function () {" +
    "    var lista = []; try { lista = Array.prototype.slice.call(document.querySelectorAll('video')); } catch (e) { }" +
    "    var escolhido = null, escolhidoRec = null, areaMaior = -1;" +
    "    for (var i = 0; i < lista.length; i++) {" +
    "      var video = lista[i], rec = vigiarVisual(video); if (!rec || !visualVisivel(video) || rec.geracao <= 0) continue;" +
    "      var area = 0; try { var caixa = video.getBoundingClientRect(); area = caixa.width * caixa.height; } catch (e) { }" +
    "      if (area > areaMaior || (area === areaMaior && (!escolhidoRec || rec.geracao > escolhidoRec.geracao))) { escolhido = video; escolhidoRec = rec; areaMaior = area; }" +
    "    }" +
    "    visualSelecionado = escolhidoRec; var agora = Date.now();" +
    "    if (!escolhido || !escolhidoRec) return { generation: 0, visible: false, attachedHa: -1, frameHa: -1, readyState: 0 };" +
    "    return { generation: escolhidoRec.geracao, visible: true," +
    "      attachedHa: escolhidoRec.anexadoEm ? agora - escolhidoRec.anexadoEm : -1," +
    "      frameHa: escolhidoRec.frameEm ? agora - escolhidoRec.frameEm : -1," +
    "      readyState: Number.isFinite(escolhido.readyState) ? escolhido.readyState : 0 };" +
    "  };" +
    "  window.__goliveRtcResumo = function () {" +
    "    var lista = Array.from(pcs);" +
    "    var promessas = lista.map(function (pc) {" +
    "      return pc.getStats().then(function (stats) {" +
    "        var r = { audio: 0, video: 0, videoTrack: false, enviando: false };" +
    "        stats.forEach(function (s) {" +
    "          var kind = s.kind || s.mediaType;" +
    "          if (s.type === 'inbound-rtp' && kind === 'audio' && typeof s.bytesReceived === 'number') { r.audio += s.bytesReceived; }" +
    "          else if (s.type === 'inbound-rtp' && kind === 'video') { r.videoTrack = true; if (typeof s.bytesReceived === 'number') r.video += s.bytesReceived; }" +
    "          else if (s.type === 'outbound-rtp' && kind === 'video' && s.bytesSent > 0) { r.enviando = true; }" +
    "        });" +
    "        return r;" +
    "      }).catch(function () { return null; });" +
    "    });" +
    "    return Promise.all(promessas).then(function (rs) {" +
    "      var agora = Date.now();" +
    "      var audio = 0, video = 0, videoTrack = false, enviando = false;" +
    "      for (var i = 0; i < rs.length; i++) {" +
    "        var r = rs[i];" +
    "        if (!r) continue;" +
    "        audio += r.audio;" +
    "        if (r.videoTrack) { videoTrack = true; video += r.video; }" +
    "        if (r.enviando) enviando = true;" +
    "      }" +
    "      if (audio > rtc.audioBytes) rtc.audioEm = agora;" +
    "      if (video > rtc.videoBytes) rtc.videoEm = agora;" +
    "      rtc.audioBytes = audio; rtc.videoBytes = video;" +
    "      rtc.videoTrack = videoTrack; rtc.enviando = enviando;" +
    "      return { pcs: lista.length, audioBytes: rtc.audioBytes, videoBytes: rtc.videoBytes," +
    "        audioHa: rtc.audioEm ? agora - rtc.audioEm : -1," +
    "        videoHa: rtc.videoEm ? agora - rtc.videoEm : -1," +
    "        videoTrack: rtc.videoTrack, enviando: rtc.enviando };" +
    "    });" +
    "  };" +
    "  var OriginalRTCPeerConnection = window.RTCPeerConnection;" +
    "  function GoliveRTCPeerConnection(cfg, cert) {" +
    "    var pc = new OriginalRTCPeerConnection(cfg, cert);" +
    "    try {" +
    "      pcs.add(pc);" +
    "      if (typeof pc.close === 'function') {" +
    "        var fecharPc = pc.close.bind(pc);" +
    "        pc.close = function () { pcs.delete(pc); return fecharPc(); };" +
    "      }" +
    "    } catch (e) { }" +
    "    return pc;" +
    "  }" +
    "  GoliveRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;" +
    "  window.RTCPeerConnection = GoliveRTCPeerConnection;" +
    "  var OriginalWebSocket = window.WebSocket;" +
    "  function GoliveWebSocket(url, protocolos) {" +
    "    var ws = protocolos === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocolos);" +
    "    try {" +
"      var alvo = String(url);" +
    "      var ehMidia = false, ehGw = false;" +
    "      try { ehMidia = /(^|\\.)discord\\.media$/.test(new URL(alvo).hostname); } catch (e) { }" +
    "      try { ehGw = /(^|\\.)gateway(-[a-z0-9-]+)?\\.discord\\.gg$/.test(new URL(alvo).hostname); } catch (e) { }" +
    "      if (ehMidia) {" +
    "        var metaMidia = { id:++midiaSeq, createdAt:Date.now(), openedAt:0, kind:'' };" +
    "        midia.add(ws); midiaMeta.set(ws, metaMidia);" +
    "        ws.addEventListener('open', function () { metaMidia.openedAt=Date.now(); midiaAbertaEm=metaMidia.openedAt; });" +
    "        ws.addEventListener('close', function () { midia.delete(ws); midiaMeta.delete(ws); midiaFechouEm=Date.now(); });" +
    "        try {" +
    "          var originalMidiaSend = ws.send;" +
    "          ws.send = function (dados) {" +
    "            try {" +
    "              if (typeof dados === 'string' && dados.charCodeAt(0) === 123) {" +
    "                var p = JSON.parse(dados);" +
    "                if (p && p.op === 0 && p.d) {" +
    // Prova de Go Live e so o array de streams; video:true sozinho e camera
    // em call de voz e nao pode virar alvo de close direcionado (#186).
    "                  if (Array.isArray(p.d.streams) && p.d.streams.length > 0) {" +
    "                    metaMidia.kind = 'stream';" +
    "                  } else if (p.d.server_id && p.d.channel_id) {" +
    "                    metaMidia.kind = 'voice';" +
    "                  }" +
    "                }" +
    "              }" +
    "            } catch (e) { }" +
    "            return originalMidiaSend.apply(this, arguments);" +
    "          };" +
    "          ws.addEventListener('message', function (ev) {" +
    "            try {" +
    "              if (typeof ev.data === 'string' && ev.data.charCodeAt(0) === 123) {" +
    "                var p = JSON.parse(ev.data);" +
    // So classifica enquanto ainda nao ha prova forte do IDENTIFY acima (streams[] ou
    // server_id+channel_id): sem isto um op 5 recorrente podia rebaixar um socket ja
    // provado 'stream' de volta para 'voice', tirando-o do close direcionado para sempre.
    "                if (metaMidia.kind === '') {" +
    "                  if (p && (p.op === 12 || p.op === 15)) metaMidia.kind = 'stream';" +
    "                  else if (p && p.op === 5) metaMidia.kind = 'voice';" +
    "                }" +
    "              }" +
    "            } catch (e) { }" +
    "          });" +
    "        } catch (e) { }" +
    "      }" +
    "      if (ehGw) {" +
    // Contadores por GERACAO (o cliente recria o ws a cada reconexao): intencao,
    // atividade e volume so significam dentro da mesma conexao.
    "        geracao++;" +
    "        var minhaGeracao = geracao;" +
    "        gw.estado = 'conectando';" +
    "        gw.srvEm = 0; gw.cliEm = 0; gw.op1Em = 0; gw.subs = 0; gw.srvFrames = 0;" +
    "        gw.dispatches = 0; gw.dispatchEm = 0; gw.intentEm = 0; gw.abertoEm = 0;" +
    "        gw.activityEm = 0; gw.srvBytes = 0; gw.srvBytesDesdeAtividade = 0; gw.op4Em = 0;" +
    "        gw.ws = ws;" +
    "        function atual() { return geracao === minhaGeracao && gw.ws === ws; }" +
    "        opCounts = {};" +
    "        cliEnvios = [];" +
    "        textoPendente = '';" +
    "        infladorResyncs = 0;" +
    "        infladorToken++;" +
    "        iniciarInflador();" +
    "        ws.addEventListener('open', function () { if (!atual()) return; gw.estado = 'aberta'; gw.abertoEm = Date.now(); });" +
    "        ws.addEventListener('close', function () { if (!atual()) return;" +
    "          if (videoEstavaSaudavel()) { reassistirPendenteEm=Date.now(); reassistirTentou=false; reassistirCanceladaPeloUsuario=false; }" +
    "          gw.estado = 'fechada'; gw.ws = null; });" +
    "        ws.addEventListener('message', function (ev) {" +
    "          if (!atual()) return;" +
    "          var agora = Date.now();" +
    "          gw.srvEm = agora; gw.srvFrames++;" +
    "          var pedaco = ev.data;" +
    "          var tam = 0;" +
    "          if (typeof pedaco === 'string') {" +
    "            tam = pedaco.length;" +
    "            textoPendente += pedaco;" +
    "            try { processarTextoPendente(); } catch (e) { }" +
    "          } else if (pedaco && typeof pedaco.size === 'number') {" +
    "            tam = pedaco.size;" +
    "            inflarBinario(pedaco, minhaGeracao);" +
    "          } else if (pedaco && pedaco.byteLength) {" +
    "            tam = pedaco.byteLength;" +
    "            inflarBinario(pedaco, minhaGeracao);" +
    "          }" +
    "          gw.srvBytes += tam;" +
    "          gw.srvBytesDesdeAtividade += tam;" +
    "        });" +
    // Conta ops quando o payload e JSON texto (encodings antigos); no binario o
    // histograma fica vazio MESMO — o sniff de op (etf) e o gap de envios que cobrem.
    "        var enviar = ws.send.bind(ws);" +
    "        ws.send = function (dados) {" +
    "          if (!atual()) return enviar(dados);" +
    "          var agora = Date.now();" +
    "          gw.cliEm = agora;" +
    "          registrarEnvio(agora);" +
    "          if (typeof dados === 'string') {" +
    "            try {" +
    "              var op = JSON.parse(dados).op;" +
    "              opCounts[op] = (opCounts[op] || 0) + 1;" +
    "              if (op === 1) { gw.op1Em = agora; }" +
    "              else {" +
    "                if (op !== 19 && op !== 21) gw.intentEm = agora;" +
    "                if (op === 4 || op === 18 || op === 20) { gw.op4Em = agora; }" +
    "                if (op === 14 || op === 37) gw.subs++;" +
    "              }" +
    "            } catch (e) { }" +
    "          } else if (dados && (dados instanceof ArrayBuffer || typeof dados.byteLength === 'number')) {" +
    "            var opBin = opDeBinario(dados);" +
    "            if (opBin >= 0) {" +
    "              opCounts[opBin] = (opCounts[opBin] || 0) + 1;" +
    "              if (opBin !== 1 && opBin !== 19 && opBin !== 21) gw.intentEm = agora;" +
    "              if (opBin === 4 || opBin === 18 || opBin === 20) gw.op4Em = agora;" +
    "              if (opBin === 14 || opBin === 37) gw.subs++;" +
    "            }" +
    "          } else if (dados && typeof dados.arrayBuffer === 'function') {" +
    "            dados.arrayBuffer().then(function (ab) {" +
    "              var opAsync = opDeBinario(ab);" +
    "              if (atual() && (opAsync === 4 || opAsync === 18 || opAsync === 20)) {" +
    "                gw.op4Em = Date.now(); gw.intentEm = gw.op4Em;" +
    "              }" +
    "            }, function () { });" +
    "          }" +
    "          return enviar(dados);" +
    "        };" +
    "      }" +
    "    } catch (e) { }" +
    "    return ws;" +
    "  }" +
    "  GoliveWebSocket.prototype = OriginalWebSocket.prototype;" +
    "  GoliveWebSocket.CONNECTING = 0; GoliveWebSocket.OPEN = 1;" +
    "  GoliveWebSocket.CLOSING = 2; GoliveWebSocket.CLOSED = 3;" +
    "  window.WebSocket = GoliveWebSocket;" +
    "})();";

// Workers sao consultados e controlados diretamente pelo sessionId CDP no main.
// Nao existe bridge no renderer: isso isola BrowserWindows e elimina TOCTOU/ACK falso.

// Shim de FRAME gravado em arquivo e registrado como preload de sessao. Ele
// conserva a instrumentacao nativa de voz e serve de fallback/diagnostico no
// renderer; com contextIsolation nao substitui o WebSocket do mundo principal.
// Dedicated workers sao cobertos separadamente pelo auto-attach CDP acima.
const SHIM_FILE = join(HERE, "golive-shim.js");
const SHIM_PRELOAD_SRC = SHIM_VOICE_SRC;

function registrarPreloadShim() {
    try {
        fs.writeFileSync(SHIM_FILE, SHIM_PRELOAD_SRC);
    } catch (error) {
        log("nao consegui gravar o arquivo do shim: " + error.message);
        return;
    }
    try {
        const s = require("electron").session.defaultSession;
        if (typeof s.registerPreloadScript === "function") {
            s.registerPreloadScript({ type: "frame", id: "golive-shim", filePath: SHIM_FILE });
            log("gw.shim | preload do shim registrado na sessao (registerPreloadScript frame)");
        } else if (typeof s.setPreloads === "function") {
            const atuais = typeof s.getPreloads === "function" ? s.getPreloads() : [];
            if (atuais.indexOf(SHIM_FILE) === -1) s.setPreloads(atuais.concat([SHIM_FILE]));
            log("gw.shim | preload do shim registrado na sessao (setPreloads)");
        } else {
            log("gw.shim | sessao sem API de preload; ficam CDP e did-finish-load");
        }
    } catch (error) {
        log("nao consegui registrar o preload do shim: " + error.message);
    }
}

// Pill de recuperacao: elemento permanente, discreto, com reload a um clique —
// o usuario aperta no primeiro segundo de loading em vez de esperar o
// reconnect chegar sozinho (7-25 min nos relatos). Some em fullscreen e com
// midia aberta; o atalho Ctrl+Alt+R fica de pe mesmo assim (intencao explicita
// do usuario, entao executa mesmo em call — a decisao e dele, nao nossa).
const REVIVE_SRC = "(function(){" +
    "  if (window.__goliveRevive) return;" +
    "  window.__goliveRevive = true;" +
    "  function recarregar() { location.reload(); }" +
    "  window.addEventListener('keydown', function (ev) {" +
    "    if (ev.ctrlKey && ev.altKey && ev.code === 'KeyR') { ev.preventDefault(); ev.stopPropagation(); recarregar(); }" +
    "  }, true);" +
    "  var el = null;" +
    "  function criar() {" +
    "    el = document.createElement('div');" +
    "    el.id = 'golive-revive';" +
    "    el.title = 'Discord travado? Recarregar (Ctrl+Alt+R)';" +
    "    el.textContent = '\\u21BB';" +
    "    el.style.cssText = 'position:fixed;z-index:2147483646;bottom:18px;right:18px;width:24px;height:24px;" +
    "border-radius:50%;background:#2b2d31;color:#b5bac1;border:1px solid #4e5058;font-size:15px;" +
    "line-height:22px;text-align:center;cursor:pointer;opacity:.35;transition:opacity .15s;user-select:none;';" +
    "    el.onmouseenter = function(){ el.style.opacity = '1'; };" +
    "    el.onmouseleave = function(){ el.style.opacity = '.35'; };" +
    "    el.onclick = function(){ recarregar(); };" +
    "    document.body.appendChild(el);" +
    "  }" +
    "  setInterval(function () {" +
    "    var esconder = !!document.fullscreenElement || (window.__goliveMidiaAberta ? window.__goliveMidiaAberta() : false);" +
    "    if (esconder) { if (el) el.style.display = 'none'; return; }" +
    "    if (!el || !document.body.contains(el)) { criar(); }" +
    "    el.style.display = 'block';" +
    "  }, 2000);" +
"})();";

let zumbiBannerAtivo = false;
// Estado da escada de revive (ver decidirRevive). Tudo morre com reload da janela
// (watchReloads) — reload e sessao nova de verdade.
let zumbiTentativaEm = [];       // timestamps das tentativas (janela de GW_ZUMBI_JANELA_MS)
let zumbiUltimaAcaoEm = 0;       // cooldown entre acoes
let zumbiUltimaAcao = null;      // 'fechar' | 'reload'
let revivePendenteEm = 0;        // reconexao provocada pelo NOSSO close (TTL: fora da rajada/recorrencia)
let reviveFecharEm = 0;          // quando fechamos o ws (auto-cura se o cliente NAO renascer)
let reviveFecharGeracao = 0;     // geracao na hora do close
let reviveFecharOrigem = '';     // frame ou worker alvo na hora do close
let gatewayProbeRodando = false;
let gatewayProbeRepetir = false;
let gatewayProbeEpoca = 0;
let gatewayProbeBloqueadoAte = new WeakMap();
const workerInstrumentacoes = new WeakMap();
const midiaCompostaPorWebContents = new WeakMap();

// Alarme re-escopado: "silente" = servidor INTEIRO calado (nem ACK de heartbeat) com o ws
// constando aberto — morte de rede real, o cliente renasce sozinho e o banner antecipa.
// "zumbi" = protocolo vivo dos dois lados (heartbeats respondendo) mas o usuario PEDIU algo
// e NAO chegou dispatch nenhum desde o pedido (issues #145/#149/#153). Precisa do inflador
// funcionando: sem decompress, dispatch e indistinguivel de heartbeat e o caso nao dispara.
const GW_SERVIDOR_SILENCIOSO_MS = 3 * 60_000;
const GW_PROBE_CHECAGEM_MS = 60_000;
const GW_PROBE_TIMEOUT_MS = 8_000;
const GW_PROBE_COOLDOWN_TIMEOUT_MS = 5 * 60_000;
// Deixa READY/RESUMED assentar apos abrir a conexao.
const GW_ZUMBI_AQUECIMENTO_MS = 2 * 60_000;
// Cliente mandando heartbeat (intervalo ~41s).
const GW_ZUMBI_CLIENTE_VIVO_MS = 90_000;
// Espera pos-intencao antes de declarar zumbi.
const GW_ZUMBI_ESPERA_MS = 30_000;
// Janela da atividade: o burst do usuario tem que ser RECENTE (foi ele que pediu
// a tela) mas ja com prazo vencido de resposta.
const GW_ZUMBI_ATIVIDADE_JANELA_MS = 90_000;
// Volume minimo de resposta do servidor saudavel a um pedido (bytes desde a
// atividade): dispatches somam centenas de bytes inflados; o zumbi devolve so o
// baseline de heartbeat (~bytes). Agnostico de encoding — vale para JSON ou etf.
const GW_ZUMBI_RESPOSTA_BYTES = 256;
// Fluxo de voz/stream (issues #159/#160/#161, beta 8): o cliente manda op 4
// (VOICE_STATE_UPDATE — entrar em voz/stream) e o gateway saudavel responde em
// segundos com o dispatch que faz o ws de midia (*.discord.media) abrir. Prazo
// de espera antes de declarar o fluxo travado.
const GW_STREAM_ESPERA_MS = 20_000;
// O op 4 tem que ser RECENTE (foi o clique do usuario que pediu a stream).
const GW_STREAM_JANELA_MS = 90_000;
// Guarda de SAIDA: um ws de midia que fechou ha pouco + op 4 = o usuario SAINDO
// de voz/stream (ou a stream acabando) — nesses casos nenhuma midia nova abre.
const GW_STREAM_LEAVE_MS = 15_000;
// RTC nativo (issue #164): o preload do Discord vive no mundo isolado 999. O
// main junta stats outbound/inbound do discord_voice com os websockets do mundo
// principal; dado ausente ou socket sem pareamento nunca vira acao.
const VOICE_ISOLATED_WORLD_ID = 999;
const VOICE_PROBE_MS = 5_000;
const VOICE_PROBE_LOG_MS = 30_000;
// Uma Live que ja tem demanda, socket RTC pareado e amostra inbound atual, mas
// nao entrega um unico quadro, nao deve ficar "aquecendo" por um minuto. Um
// segundo e a evidencia minima; como o poll roda a cada 5s, a primeira tentativa
// acontece em ate ~6s tanto no primeiro attach quanto numa reentrada (#181/#183).
// O restante dos gates continua fail-closed: sem demanda, stats ou pareamento,
// nao ha close nenhum.
const VOICE_STREAM_AQUECIMENTO_MS = 60_000;
// Depois de um viewer que comprovadamente decodificava video, uma NOVA
// conexao RTC sem frame tambem usa a mesma janela curta. Mantemos as constantes
// nomeadas para que os testes documentem explicitamente ambos os caminhos.
const VOICE_VIEWER_REENTRADA_AQUECIMENTO_MS = 60_000;
const VOICE_VIEWER_REENTRADA_SAIDA_PARADA_MS = 60_000;
const VOICE_VIEWER_REENTRADA_JANELA_MS = 10 * 60_000;
const VOICE_DEMANDA_GRACA_MS = 15_000;
// O viewer pode trocar o pixelCount para zero ao exibir o erro 2012, embora
// continue com a tela da Live aberta. O ultimo pedido local positivo ainda e
// evidencia de intencao por uma janela curta, suficiente para a primeira cura.
const VOICE_VIEWER_DEMANDA_RECENTE_MS = 120_000;
const VOICE_ENTRADA_VIVA_MS = 15_000;
const VOICE_SAIDA_PARADA_MS = 60_000;
// O sender ainda so conclui encoder congelado aos 20s. No viewer, uma entrada
// sem quadro e o proprio sintoma: com os gates estritos acima, tentar o socket
// da stream depois de 1s e melhor que exibir Error 2012 por 60s.
const VOICE_VIEWER_SAIDA_PARADA_MS = 60_000;
const VOICE_SAMPLE_MAX_MS = 10_000;
const VOICE_SAIDA_SUCESSO_MS = 8_000;
const VOICE_SUCESSO_SUSTENTADO_MS = 10_000;
// Sem demanda remota positiva, captura viva + encoder zero e apenas o estado
// ocioso da Live. Com demanda positiva, a captura viva e a saida parada provam
// o travamento mesmo se targetMediaBitrate continuar zero (repro ao vivo em
// 01/09). A cura fecha apenas o websocket RTC criado junto da conexao stream;
// a voz principal permanece aberta.
const VOICE_SOCKET_PAREAMENTO_MS = 15_000;
const VOICE_NIVEL1_ESPERA_MS = 30_000;
const VOICE_NOVA_GERACAO_GRACA_MS = 20_000;
const VOICE_SEM_DEMANDA_ESPERA_MS = 60_000;
const VOICE_ACAO_COOLDOWN_MS = 30_000;
const VOICE_TENTATIVAS = 1;
const VOICE_JANELA_MS = 30 * 60_000;
// Teto de tentativas da escada na janela.
const GW_ZUMBI_TENTATIVAS = 2;
// Janela de contagem das tentativas.
const GW_ZUMBI_JANELA_MS = 30 * 60_000;
// Cooldown entre tentativas da escada.
const GW_ZUMBI_COOLDOWN_MS = 3 * 60_000;
// A reconexao do nosso close deixa de ser "revive" (sair da rajada/recorrencia) depois disto.
const GW_REVIVE_TTL_MS = 60_000;
// Midia fechada ha menos de 3min: pode ainda ter call viva — nao age automatico.
const GW_REVIVE_MIDIA_GRACA_MS = 3 * 60_000;
// Prazo do cliente renascer o ws apos o close 4000.
const GW_REVIVE_RENASCE_MS = 15_000;

// Duas idades em ms (-1 = nunca); devolve a menor delas ignorando as ausentes.
function minIdade(a, b) {
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
}

// Funcao pura — os campos *Ha sao IDADES em ms desde o ultimo evento (o shim mede no
// momento do poll), comparadas DIRETO contra os prazos. A beta.4 fazia `agora - srvHa`
// (idade tratada como timestamp): o gate nunca filtrava e o banner disparava em falso.
//
// Zumbi tem DOIS caminhos, porque o cliente do Discord migrou para frames binarios
// (issues #154/#156/#158: ops={} e "sem decompress" em toda sessao, revives=0):
// 1. Payload decodificavel (JSON): dispatch starve — nada despachado desde o pedido.
// 2. Qualquer encoding (o caminho que salva o beta 8): o usuario deu um BURST de
//    envios (atividade) e o servidor devolveu MENOS que o baseline de heartbeat
//    (GW_ZUMBI_RESPOSTA_BYTES) desde entao. Saude = resposta de verdade ao pedido;
//    zumbi = sessao protocolarmente viva que ignora o que foi pedido.
function avaliarSinalGw(resumo, agora) {
    if (!resumo || resumo.estado !== 'aberta') return null;
    if (resumo.srvHa >= GW_SERVIDOR_SILENCIOSO_MS) return 'silente';
    if (resumo.abertoHa < 0 || resumo.abertoHa < GW_ZUMBI_AQUECIMENTO_MS) return null;
    if (resumo.cliHa < 0 || resumo.cliHa >= GW_ZUMBI_CLIENTE_VIVO_MS) return null;
    // CAMINHO 3 (o que pega o caso REAL da beta 8 — #159/#160/#161): o usuario
    // PEDIU entrada em voz/stream (op 4, sniffado do binario etf ou lido do JSON)
    // ha pouco, NENHUM ws de midia abriu desde o pedido e nao ha midia aberta —
    // o fluxo de voz nunca comecou e a view fica em "carregando" para sempre.
    // Nao depende de decode de dispatch nem de inflate: funciona com o servidor
    // empurrando dados ambiente (resp_bytes alto) como nos logs da beta 8.
    if (resumo.op4Ha >= 0 && resumo.op4Ha >= GW_STREAM_ESPERA_MS && resumo.op4Ha <= GW_STREAM_JANELA_MS &&
        resumo.midiaAberta !== true &&
        (resumo.midiaOpenHa < 0 || resumo.midiaOpenHa > resumo.op4Ha) &&
        (resumo.midiaCloseHa < 0 || resumo.midiaCloseHa > GW_STREAM_LEAVE_MS)) {
        return 'zumbi';
    }
    if (resumo.infladorOk !== true) return null;
    // O usuario pediu algo: op explicita (JSON) OU burst de envios (binario).
    const pediuHa = minIdade(resumo.intentHa, resumo.activityHa);
    if (pediuHa < 0 || pediuHa < GW_ZUMBI_ESPERA_MS || pediuHa > GW_ZUMBI_ATIVIDADE_JANELA_MS) return null;
    // Dispatch DEPOIS do pedido = dado chegando (saudavel) — caminho 1.
    if (resumo.dispatchHa >= 0 && resumo.dispatchHa < pediuHa) return null;
    // Caminho 2 (mundo binario, dispatchHa == -1 para sempre): o pedido ficou sem
    // resposta de volume. Com dispatches visiveis este checagem nao roda — o caminho
    // 1 mandou o veredito acima.
    if (resumo.dispatchHa < 0 && resumo.srvBytesDesdeAtividade >= GW_ZUMBI_RESPOSTA_BYTES) return null;
    return 'zumbi';
}

// Funcao pura da escada (testavel): com o zumbi confirmado, decide a acao.
// ctx: { agora, midiaAberta, midiaRecente, tentativas[], ultimaAcaoEm, ultimaAcao }
function decidirRevive(ctx) {
    // §6/AGENTS.md: reconexao de gateway mata o video de call/live em andamento — nunca agir.
    if (ctx.midiaAberta || ctx.midiaRecente) return { acao: 'banner', motivo: 'midia' };
    const tentativas = ctx.tentativas.filter(t => t >= ctx.agora - GW_ZUMBI_JANELA_MS);
    if (tentativas.length >= GW_ZUMBI_TENTATIVAS) return { acao: 'banner', motivo: 'teto_tentativas' };
    if (ctx.ultimaAcaoEm > 0 && ctx.agora - ctx.ultimaAcaoEm < GW_ZUMBI_COOLDOWN_MS) return { acao: 'nenhum', motivo: 'cooldown' };
    // Escada: a primeira acao e fechar (close 4000, RESUME preserva a sessao); se o close
    // nao curou, sobe para o reload — a cura que sempre funciona.
    if (ctx.ultimaAcao === 'fechar') return { acao: 'reload', motivo: 'nivel2' };
    return { acao: 'fechar', motivo: 'nivel1' };
}

const ZUMBI_BANNER_TEXT = "GoLiveBypass: a sessao do gateway esta sem resposta ha alguns " +
    "minutos — as telas podem ficar carregando para sempre. Clique em \"Reiniciar agora\" " +
    "abaixo (ou Ctrl+Alt+R) para recarregar a janela.";

// Banner flutuante generico (mesmo padrao visual, ids diferentes: os avisos
// coexistem sem um apagar o outro, e nunca empilham — um elemento so por id,
// sempre reaproveitado com o texto novo).
function mostrarBannerFixo(id, texto, corBorda) {
    const win = clientWindow();
    if (win === null) return;
    const script = "(function(){\n" +
        "  var el = document.getElementById('" + id + "');\n" +
        "  if (!el) {\n" +
        "    el = document.createElement('div');\n" +
        "    el.id = '" + id + "';\n" +
        "    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "display:flex;align-items:flex-start;gap:10px;width:320px;" +
        "background:#2b2d31;color:#f2f3f5;padding:14px 16px;border-radius:10px;" +
        "border-left:4px solid " + corBorda + ";" +
        "font:13px/1.45 \"gg sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);" +
        "opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;'; \n" +
        "    var icon = document.createElement('div');\n" +
        "    icon.textContent = '\\u26A0\\uFE0F';\n" +
        "    icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;';\n" +
        "    var body = document.createElement('div');\n" +
        "    body.style.cssText = 'flex:1;min-width:0;';\n" +
        "    var title = document.createElement('div');\n" +
        "    title.textContent = 'GoLiveBypass';\n" +
        "    title.style.cssText = 'font-weight:600;margin-bottom:3px;color:#fff;';\n" +
        "    var text = document.createElement('div');\n" +
        "    text.id = '" + id + "-text';\n" +
        "    text.style.cssText = 'color:#d8dadf;';\n" +
        "    var restartBtn = document.createElement('button');\n" +
        "    restartBtn.type = 'button';\n" +
        "    restartBtn.textContent = 'Reiniciar agora';\n" +
        "    restartBtn.style.cssText = 'margin-top:8px;padding:5px 10px;border:0;" +
        "border-radius:6px;background:#f0b232;color:#111214;font-weight:600;font-size:12px;" +
        "cursor:pointer;';\n" +
        "    restartBtn.onmouseenter = function(){ restartBtn.style.background = '#f5c862'; };\n" +
        "    restartBtn.onmouseleave = function(){ restartBtn.style.background = '#f0b232'; };\n" +
        "    restartBtn.onclick = function(){ location.reload(); };\n" +
        "    body.appendChild(title);\n" +
        "    body.appendChild(text);\n" +
        "    body.appendChild(restartBtn);\n" +
        "    var closeBtn = document.createElement('div');\n" +
        "    closeBtn.textContent = '\\u2715';\n" +
        "    closeBtn.style.cssText = 'cursor:pointer;color:#949ba4;font-size:14px;flex-shrink:0;padding:2px;';\n" +
        "    closeBtn.onclick = function(){ el.remove(); };\n" +
        "    el.appendChild(icon);\n" +
        "    el.appendChild(body);\n" +
        "    el.appendChild(closeBtn);\n" +
        "    document.body.appendChild(el);\n" +
        "    requestAnimationFrame(function(){ el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });\n" +
        "  }\n" +
        "  document.getElementById('" + id + "-text').textContent = " + JSON.stringify(texto) + ";\n" +
        "})();";
    win.webContents.executeJavaScript(script).catch(error => log("falhei ao mostrar aviso de sessao muda: " + error.message));
}

function showZumbiBanner() {
    mostrarBannerFixo('golivebypass-zumbi', ZUMBI_BANNER_TEXT, '#f0b232');
}

function hideZumbiBanner() {
    if (!zumbiBannerAtivo) return;
    zumbiBannerAtivo = false;
    const win = clientWindow();
    if (win === null) return;
    const script = "(function(){ var el = document.getElementById('golivebypass-zumbi'); " +
        "if (el) { el.style.opacity = '0'; setTimeout(function(){ el.remove(); }, 250); } })();";
    win.webContents.executeJavaScript(script).catch(() => { });
}

// Recuperacao do RTC da STREAM (issue #164). A escada so considera o sender
// travado quando ha demanda remota positiva, captura viva e encoder parado.
// Reconecta somente o websocket criado junto da stream; nunca fecha a voz
// principal, nunca toca no gateway e nunca chama reload automaticamente.
let videoNativoTentativas = [];
// O teto e por sessao logica de Live, nao pelo uptime inteiro do Discord.
// A chave nunca usa stream ID/URL: sender = fonte selecionada; viewer = nova
// intencao positiva de assistir. A reconexao causada pelo nosso close(4000)
// conserva ambas, portanto nao vira loop de tentativas.
let videoNativoOrcamentoChave = '';
let videoNativoUltimaAcaoEm = 0;
let videoNativoPendente = null;
let videoNativoBloqueadoGeracao = '';
let videoNativoBloqueadoEm = 0;
let viewerNativoUltimaSaudavelGeracao = '';
let viewerNativoUltimaSaudavelEm = 0;
let videoBannerAtivo = false;
let voiceProbeRodando = false;
let voiceProbeEpoca = 0;
let voiceProbeUltimoLogEm = 0;
let voiceProbeUltimaAssinatura = '';
let voiceHookLogado = false;
let voiceUltimaGeracaoLogada = '';
let voiceIsolatedAvisado = false;

const VIDEO_BANNER_TEXT = "GoLiveBypass: a conexao RTC da transmissao nao entregou video. " +
    "Tentamos renegociar somente a stream sem derrubar sua call, mas o video nao voltou. " +
    "Reiniciar o renderer e a unica recuperacao confirmada para este estado.";

function showVideoBanner() {
    videoBannerAtivo = true;
    mostrarBannerFixo('golivebypass-video', VIDEO_BANNER_TEXT, '#f0b232');
}

function hideVideoBanner(win) {
    if (!videoBannerAtivo) return;
    videoBannerAtivo = false;
    try {
        win.webContents.executeJavaScript("(function(){var e=document.getElementById('golivebypass-video');if(e)e.remove();})()")
            .catch(() => { });
    } catch { }
}

function streamNativaAtiva(voice) {
    if (!voice || !Array.isArray(voice.connections)) return null;
    let achada = null;
    for (const conn of voice.connections) {
        if (!conn || conn.destroyed === true || conn.kind !== 'stream') continue;
        if (achada === null || conn.id > achada.id) achada = conn;
    }
    return achada;
}

function voiceNativaAtiva(voice) {
    if (!voice || !Array.isArray(voice.connections)) return null;
    let achada = null;
    for (const conn of voice.connections) {
        if (!conn || conn.destroyed === true || conn.kind !== 'voice') continue;
        if (achada === null || conn.id > achada.id) achada = conn;
    }
    return achada;
}

function geracaoNativa(voice, stream) {
    if (!voice || !stream) return '';
    return String(voice.instanceId || 'legacy') + ':' + String(stream.id);
}

// Uma conexao discord_voice pode sobreviver a uma nova entrada do viewer. A
// geracao da pagina completa essa identidade apenas para quem recebe a Live:
// ela e um contador opaco local, sem stream id, track id nem URL do Discord.
function visualViewerAtivo(ctx, stream) {
    const visual = ctx && ctx.visual;
    return !!(stream && stream.role === 'viewer' && visual &&
        Number.isInteger(visual.generation) && visual.generation > 0);
}

function geracaoViewerNativa(ctx, stream) {
    const nativa = geracaoNativa(ctx && ctx.voice, stream);
    if (!nativa) return '';
    return visualViewerAtivo(ctx, stream) ? nativa + '@v' + ctx.visual.generation : nativa;
}

function visualViewerRenderizado(ctx, stream) {
    const visual = ctx && ctx.visual;
    if (!visualViewerAtivo(ctx, stream) || visual.visible !== true || visual.readyState < 2) return false;
    return typeof visual.frameHa === 'number' && Number.isFinite(visual.frameHa) &&
        visual.frameHa >= 0 && visual.frameHa <= VOICE_SAIDA_SUCESSO_MS;
}

function viewerReentradaAposSaude(ctx, stream) {
    if (!stream || stream.role !== 'viewer') return false;
    if (!ctx || typeof ctx.viewerSaudavelGeracao !== 'string' || ctx.viewerSaudavelGeracao === '') return false;
    if (typeof ctx.viewerSaudavelHa !== 'number' || ctx.viewerSaudavelHa < 0 ||
        ctx.viewerSaudavelHa > VOICE_VIEWER_REENTRADA_JANELA_MS) return false;
    return ctx.viewerSaudavelGeracao !== geracaoViewerNativa(ctx, stream);
}

function demandaRtcDaStream(ctx, stream) {
    const raiz = ctx && ctx.demanda;
    if (!raiz || !stream) return null;
    let demanda = raiz;
    if (stream.role === 'viewer' && raiz.viewer) demanda = raiz.viewer;
    else if (stream.role === 'sender' && raiz.sender) demanda = raiz.sender;
    if (!demanda || demanda.known !== true) return demanda || null;
    if (stream.role === 'viewer' && demanda.active !== true &&
        typeof demanda.demandHa === 'number' && demanda.demandHa >= 0 &&
        demanda.demandHa <= VOICE_VIEWER_DEMANDA_RECENTE_MS) {
        return { ...demanda, active: true, recentOnly: true };
    }
    return demanda;
}

function chaveOrcamentoRtc(ctx, stream) {
    const voice = ctx && ctx.voice;
    if (!voice || !stream || !Number.isInteger(voice.instanceId) || voice.instanceId <= 0) return '';
    const demanda = demandaRtcDaStream(ctx, stream);
    if (!demanda || !Number.isInteger(demanda.epoch) || demanda.epoch <= 0) return '';
    const streamId = Number.isInteger(stream.id) ? stream.id : 0;
    if (stream.role === 'sender') {
        // Nem toda versao do discord_voice expoe setDesktopSource no objeto
        // que chegou ao nosso hook. Quando ele existe, a fonte e o marcador
        // mais preciso de uma Live nova. Quando nao existe, a transicao local
        // de demanda remota ainda distingue uma nova sessao da reconexao que
        // o nosso close(4000) provoca: esta ultima mantem a demanda positiva.
        if (Number.isInteger(voice.sourceEpoch) && voice.sourceEpoch > 0) {
            return 'sender:' + voice.instanceId + ':stream:' + streamId + ':fonte:' + voice.sourceEpoch;
        }
        return 'sender:' + voice.instanceId + ':stream:' + streamId + ':demanda:' + demanda.epoch;
    }
    if (stream.role === 'viewer') {
        return 'viewer:' + voice.instanceId + ':stream:' + streamId + ':demanda:' + demanda.epoch;
    }
    return '';
}

function renovarOrcamentoRtc(ctx, stream) {
    const chave = chaveOrcamentoRtc(ctx, stream);
    // Telemetria antiga/incompleta nao recebe privilegio de reiniciar a
    // escada: conserva o teto atual e falha fechado.
    if (chave === '' || chave === videoNativoOrcamentoChave) return;
    // Se ha tentativa de recuperacao pendente em voo, adiar a renovacao da chave:
    // sobrescrever videoNativoOrcamentoChave agora sem limpar tentativas impediria
    // a renovacao definitiva apos a tentativa terminar, travando a escada.
    if (videoNativoPendente !== null) return;
    const anterior = videoNativoOrcamentoChave;
    videoNativoOrcamentoChave = chave;
    videoNativoTentativas.length = 0;
    videoNativoUltimaAcaoEm = 0;
    videoNativoBloqueadoGeracao = '';
    videoNativoBloqueadoEm = 0;
    hideVideoBanner(ctx.win);
    if (anterior !== '') {
        log('gw.revive | rtc stream: nova sessao logica; teto de recuperacao renovado');
    }
}

// Pareia os dois mundos pelo protocolo quando ele ja prova o papel do socket;
// sem essa prova, usa idade de criacao. Em call normal o socket da voz e antigo;
// ao abrir uma Live, o socket RTC e a conexao nativa de stream nascem em poucos
// segundos. Ambiguidade ou delta acima de 15s falha fechado.
function socketMidiaDaStream(ctx, stream) {
    const sockets = ctx && ctx.midia && Array.isArray(ctx.midia.midiaSockets)
        ? ctx.midia.midiaSockets.filter(s => s && s.readyState === 1 && typeof s.id === 'number' &&
            typeof s.createdHa === 'number' && Number.isFinite(s.createdHa))
        : [];
    if (!stream || typeof stream.createdHa !== 'number' || sockets.length === 0) return null;
    // 1. Identificacao direta protocolar: sockets explicitamente provados como stream
    const streamsMarcados = sockets.filter(s => s.kind === 'stream');
    if (streamsMarcados.length === 1) return streamsMarcados[0];
    if (streamsMarcados.length > 1) {
        let maisNovo = streamsMarcados[0];
        for (let i = 1; i < streamsMarcados.length; i++) {
            if (streamsMarcados[i].createdHa < maisNovo.createdHa) maisNovo = streamsMarcados[i];
        }
        return maisNovo;
    }

    // 2. Protecao: descartar sockets explicitamente provados como voz principal
    const candidatas = sockets.filter(s => s.kind !== 'voice');
    if (candidatas.length === 0) return null;

    // Sem classificacao protocolar, uma call com Live normalmente tem voz base
    // + stream. Um unico socket sem papel provado continua ambiguo: parear por
    // proximidade poderia fechar a voz. Esta guarda NAO vale para kind=stream:
    // apos RTCControlSocket.reconnect o socket da voz pode nao aparecer neste
    // contexto, mas o IDENTIFY/midia ja provou cirurgicamente que o unico aberto
    // pertence a Live (issue #186).
    if (voiceNativaAtiva(ctx && ctx.voice) && sockets.length < 2) return null;

    // 3. Fallback original: pareamento temporal estrito por delta de criacao
    let melhor = null;
    let melhorDelta = Infinity;
    let empate = false;
    for (const socket of candidatas) {
        const delta = Math.abs(socket.createdHa - stream.createdHa);
        if (delta < melhorDelta) {
            melhor = socket;
            melhorDelta = delta;
            empate = false;
        } else if (delta === melhorDelta) {
            empate = true;
        }
    }
    if (empate || melhorDelta > VOICE_SOCKET_PAREAMENTO_MS) return null;
    return melhor;
}

// Funcao pura e fail-closed. Viewer: conexao stream + demanda positiva, mas
// video inbound ausente/parado por 60s. Transmissor: demanda remota positiva,
// captura viva e encoder parado por 20s. targetMediaBitrate nao participa do
// veredito: o Discord pode deixa-lo em zero mesmo com um viewer real esperando.
function avaliarRtcNativo(ctx) {
    if (!ctx || !ctx.voice || ctx.voice.installed !== true || ctx.voice.voiceHooked !== true) return null;
    if (!ctx.midia || ctx.midia.midiaAberta !== true) return null;
    const stream = streamNativaAtiva(ctx.voice);
    const reentradaRapida = viewerReentradaAposSaude(ctx, stream);
    const aquecimento = reentradaRapida ? VOICE_VIEWER_REENTRADA_AQUECIMENTO_MS : VOICE_STREAM_AQUECIMENTO_MS;
    if (!stream || stream.createdHa < aquecimento) return null;
    const demanda = demandaRtcDaStream(ctx, stream);
    if (!demanda || demanda.known !== true || demanda.active !== true) return null;
    if (demanda.demandHa < 0 || demanda.demandHa > stream.createdHa + VOICE_DEMANDA_GRACA_MS) return null;
    const stats = stream.stats;
    if (!stats || stats.statsOk !== true) return null;
    if (typeof stats.sampleHa !== 'number' || !Number.isFinite(stats.sampleHa) ||
        stats.sampleHa < 0 || stats.sampleHa > VOICE_SAMPLE_MAX_MS) return null;
    if (!socketMidiaDaStream(ctx, stream)) return null;
    if (stream.role === 'viewer' && stats.direction === 'inbound') {
        // Nao derruba o video inbound do viewer durante handshake ou espera de pacotes
        return null;
    }
    if (stream.role !== 'sender' || stats.direction !== 'outbound') return null;
    if (stats.entradaHa < 0 || stats.entradaHa > VOICE_ENTRADA_VIVA_MS) return null;
    if (!(typeof stats.captureFrames === 'number' || stats.inputFrameRate > 0)) return null;
    if (typeof stats.framesEncoded !== 'number' || typeof stats.encodeFrameRate !== 'number') return null;
    if (stats.saidaHa < VOICE_SAIDA_PARADA_MS) return null;
    return 'sender-video-parado';
}

function rtcNativoSaudavel(ctx, geracaoAnterior) {
    const stream = streamNativaAtiva(ctx && ctx.voice);
    if (!stream) return null;
    const stats = stream.stats;
    const demanda = demandaRtcDaStream(ctx, stream);
    if (!demanda || demanda.known !== true || demanda.active !== true) return null;
    if (!ctx.midia || ctx.midia.midiaAberta !== true) return null;
    if (demanda.demandHa < 0 || demanda.demandHa > stream.createdHa + VOICE_DEMANDA_GRACA_MS) return null;
    if (!stats || stats.statsOk !== true || typeof stats.sampleHa !== 'number' ||
        !Number.isFinite(stats.sampleHa) || stats.sampleHa < 0 || stats.sampleHa > VOICE_SAMPLE_MAX_MS) return null;
    if (stream.role === 'viewer' && stats.direction === 'inbound') {
        if (stats.videoPresent !== true || typeof stats.videoHa !== 'number' ||
            stats.videoHa < 0 || stats.videoHa > VOICE_SAIDA_SUCESSO_MS) return null;
        // Bytes de um burst pre-DAVE e o numero 0 sao evidencia de que o track
        // existe, nao de que o video foi entregue. So um frame realmente
        // decodificado/renderizado pode preservar a memoria de stream saudavel.
        if (!((typeof stats.framesDecoded === 'number' && Number.isFinite(stats.framesDecoded) && stats.framesDecoded > 0) ||
            (typeof stats.decodeFrameRate === 'number' && Number.isFinite(stats.decodeFrameRate) && stats.decodeFrameRate > 0) ||
            (typeof stats.renderFrameRate === 'number' && Number.isFinite(stats.renderFrameRate) && stats.renderFrameRate > 0))) return null;
        // O addon mede a conexao e pode manter frames da Live anterior depois
        // de o DirectVideo entrar no erro 2012. Quando o resumo visual existe,
        // so a apresentacao de um frame novo confirma a cura. Sem o resumo
        // (renderer antigo/indisponivel), mantemos o criterio legado para nao
        // transformar falha de observacao em fechamento destrutivo.
        if (ctx.visual !== undefined && ctx.visual !== null && !visualViewerRenderizado(ctx, stream)) return null;
        return stream;
    }
    if (stream.role !== 'sender' || stats.direction !== 'outbound') return null;
    if (stats.entradaHa < 0 || stats.entradaHa > VOICE_ENTRADA_VIVA_MS) return null;
    if (stats.saidaHa < 0 || stats.saidaHa > VOICE_SAIDA_SUCESSO_MS) return null;
    if (!(stats.encodeFrameRate > 0) || typeof stats.framesEncoded !== 'number') return null;
    return stream;
}

// Depois de reconectar o RTC da stream, a demanda pode zerar por alguns segundos
// enquanto o sink renegocia. Isso pausa a escada; demanda ausente por 60s
// encerra a observacao sem escalar e sem declarar sucesso.
function decidirDemandaRecuperacao(demanda) {
    if (!demanda || demanda.known !== true) return 'encerrar';
    if (demanda.active === true) return 'continuar';
    if (typeof demanda.changedHa !== 'number' || !Number.isFinite(demanda.changedHa) ||
        demanda.changedHa < VOICE_SEM_DEMANDA_ESPERA_MS) return 'aguardar';
    return 'encerrar';
}

function numeroResumo(valor, fallback, maximo) {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) return fallback;
    if (valor < -1) return fallback;
    return Math.min(valor, maximo);
}

function contadorResumo(valor, maximo) {
    return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0
        ? Math.min(valor, maximo) : 0;
}

// O renderer entrega somente estado visual agregado. Validar e copiar esse
// pequeno contrato impede que objetos, IDs ou valores inesperados atravessem
// a fronteira do contexto da pagina para a decisao de recuperacao.
function normalizarResumoVisual(valor) {
    if (!valor || typeof valor !== 'object') return null;
    if (!Number.isInteger(valor.generation) || valor.generation < 0 || valor.generation > 1_000_000_000) return null;
    if (typeof valor.visible !== 'boolean') return null;
    if (!Number.isInteger(valor.readyState) || valor.readyState < 0 || valor.readyState > 4) return null;
    return {
        generation: valor.generation,
        visible: valor.visible,
        attachedHa: numeroResumo(valor.attachedHa, -1, 7 * 24 * 60 * 60_000),
        frameHa: numeroResumo(valor.frameHa, -1, 7 * 24 * 60 * 60_000),
        readyState: valor.readyState,
    };
}

// Resultado de Runtime.evaluate nunca e confiado por referencia: copia somente
// escalares conhecidos, limita contadores/arrays e elimina URL/payload/token.
function normalizarResumoInstrumentado(valor, origem, sessaoId, instaladoEm) {
    if (!valor || typeof valor !== 'object') return null;
    const estados = new Set(['nenhum', 'conectando', 'aberta', 'fechada']);
    if (!estados.has(valor.estado)) return null;
    if (!Number.isInteger(valor.geracao) || valor.geracao < 0 || valor.geracao > 1_000_000_000) return null;
    const sockets = Array.isArray(valor.midiaSockets) ? valor.midiaSockets.slice(0, 16).map(item => {
        if (!item || !Number.isInteger(item.id) || item.id <= 0 || item.id > 1_000_000_000) return null;
        if (!Number.isInteger(item.readyState) || item.readyState < 0 || item.readyState > 3) return null;
        return {
            id: item.id,
            createdHa: numeroResumo(item.createdHa, -1, 7 * 24 * 60 * 60_000),
            openHa: numeroResumo(item.openHa, -1, 7 * 24 * 60 * 60_000),
            readyState: item.readyState,
            kind: typeof item.kind === 'string' && (item.kind === 'stream' || item.kind === 'voice') ? item.kind : '',
        };
    }).filter(Boolean) : [];
    const opCounts = {};
    if (valor.opCounts && typeof valor.opCounts === 'object') {
        for (const op of ['0', '1', '4', '14', '18', '19', '20', '21', '22', '37']) {
            const n = valor.opCounts[op];
            if (typeof n === 'number' && Number.isFinite(n) && n >= 0) opCounts[op] = Math.min(n, 1_000_000_000);
        }
    }
    const workerId = origem === 'worker' && typeof valor.workerId === 'string' &&
        /^[a-z0-9-]{3,80}$/.test(valor.workerId) ? valor.workerId : '';
    if (origem === 'worker' && workerId === '') return null;
    return {
        origem, workerId,
        geracao: valor.geracao,
        estado: valor.estado,
        srvHa: numeroResumo(valor.srvHa, -1, 7 * 24 * 60 * 60_000),
        cliHa: numeroResumo(valor.cliHa, -1, 7 * 24 * 60 * 60_000),
        abertoHa: numeroResumo(valor.abertoHa, -1, 7 * 24 * 60 * 60_000),
        srvFrames: contadorResumo(valor.srvFrames, 1_000_000_000),
        srvBytes: contadorResumo(valor.srvBytes, Number.MAX_SAFE_INTEGER),
        srvBytesDesdeAtividade: contadorResumo(valor.srvBytesDesdeAtividade, Number.MAX_SAFE_INTEGER),
        cliEnvios: contadorResumo(valor.cliEnvios, 1_000_000_000),
        dispatches: contadorResumo(valor.dispatches, 1_000_000_000),
        dispatchHa: numeroResumo(valor.dispatchHa, -1, 7 * 24 * 60 * 60_000),
        intentHa: numeroResumo(valor.intentHa, -1, 7 * 24 * 60 * 60_000),
        activityHa: numeroResumo(valor.activityHa, -1, 7 * 24 * 60 * 60_000),
        op4Ha: numeroResumo(valor.op4Ha, -1, 7 * 24 * 60 * 60_000),
        subs: contadorResumo(valor.subs, 1_000_000_000),
        opCounts,
        infladorOk: origem === 'frame' && valor.infladorOk === true,
        midia: sockets.length,
        midiaAberta: ((origem === 'frame' || origem === 'network') && valor.midiaAberta === true) ||
            sockets.some(socket => socket.readyState === 0 || socket.readyState === 1),
        midiaOpenHa: numeroResumo(valor.midiaOpenHa, -1, 7 * 24 * 60 * 60_000),
        midiaCloseHa: numeroResumo(valor.midiaCloseHa, -1, 7 * 24 * 60 * 60_000),
        midiaSockets: sockets,
        pcs: contadorResumo(valor.pcs, 1000),
        _workerSessionId: origem === 'worker' ? sessaoId : '',
        _workerInstaladoEm: origem === 'worker' ? instaladoEm : 0,
    };
}

function idadeMaisNova(atual, nova) {
    if (typeof nova !== 'number' || nova < 0) return atual;
    if (typeof atual !== 'number' || atual < 0) return nova;
    return Math.min(atual, nova);
}

function prioridadeEstado(estado) {
    if (estado === 'aberta') return 3;
    if (estado === 'conectando') return 2;
    if (estado === 'fechada') return 1;
    return 0;
}

// O payload binario exposto por Network.webSocketFrame* vem em base64. Aceita
// as duas formas observadas (tupla antiga e MAP_EXT atual com chave <<"op">>);
// todo formato diferente falha fechado. Esta copia roda no main (Buffer), separada
// do parser defensivo que e embutido no shim do renderer/worker.
function opEtfCdp(payloadBase64) {
    try {
        if (typeof payloadBase64 !== 'string' || payloadBase64.length === 0 ||
            payloadBase64.length > 4 * 1024 * 1024) return -1;
        const u = Buffer.from(payloadBase64, 'base64');
        if (u.length < 8 || u[0] !== 131) return -1;
        let p = -1;
        if (u[1] === 104) p = 3;
        else if (u[1] === 105) p = 6;
        else if (u[1] === 116) {
            if (u.length < 15 || u[6] !== 109) return -1;
            const tamChave = (u[7] * 16777216) + (u[8] * 65536) + (u[9] * 256) + u[10];
            if (tamChave !== 2 || u[11] !== 111 || u[12] !== 112) return -1;
            p = 13;
        } else return -1;
        let op = -1;
        if (u[p] === 97) op = u[p + 1];
        else if (u[p] === 98) {
            op = (u[p + 1] * 16777216) + (u[p + 2] * 65536) +
                (u[p + 3] * 256) + u[p + 4];
        }
        return op === 1 || op === 4 || op === 14 ||
            op === 18 || op === 19 || op === 20 || op === 21 || op === 22 || op === 37 ? op : -1;
    } catch { return -1; }
}

function comporResumoInstrumentado(win, resumoFrame, resumosWorker) {
    const wc = win && win.webContents;
    if (!wc) return null;
    const fontes = [];
    const local = normalizarResumoInstrumentado(resumoFrame, 'frame', '', 0);
    if (local) fontes.push(local);
    if (Array.isArray(resumosWorker)) fontes.push(...resumosWorker.filter(Boolean));
    if (fontes.length === 0) return null;

    // Network e o observador universal e enxerga o mesmo socket que um shim
    // eventualmente capturou. Quando ha uma fonte JS com geracao, ela e mais
    // rica/acionavel e elimina somente a DUPLICATA Network da eleicao do
    // gateway; a telemetria de midia de todas as fontes continua nas guardas.
    const temFonteJs = fontes.some(item => item.origem !== 'network' && item.geracao > 0);
    const fontesGateway = temFonteJs ? fontes.filter(item => item.origem !== 'network') : fontes;
    const candidatas = fontesGateway.filter(item => item.geracao > 0);
    let escolhida = null;
    for (const fonte of candidatas) {
        if (!escolhida || prioridadeEstado(fonte.estado) > prioridadeEstado(escolhida.estado) ||
            (prioridadeEstado(fonte.estado) === prioridadeEstado(escolhida.estado) &&
                ((fonte.origem === 'frame' && escolhida.origem !== 'frame') ||
                    (fonte.origem === 'worker' && escolhida.origem === 'worker' &&
                        fonte._workerInstaladoEm > escolhida._workerInstaladoEm)))) escolhida = fonte;
    }
    if (!escolhida) escolhida = local || fontes[0];
    const composto = Object.assign({}, escolhida);
    composto.gatewayAmbiguo = fontesGateway.filter(item => item.geracao > 0 && item.estado === 'aberta').length > 1;
    composto.midiaAberta = false;
    composto.midiaOpenHa = -1;
    composto.midiaCloseHa = -1;
    composto.midiaSockets = [];

    let registro = midiaCompostaPorWebContents.get(wc);
    if (!registro) {
        registro = { proximoId: -1, idsPorChave: new Map(), alvos: new Map() };
        midiaCompostaPorWebContents.set(wc, registro);
    }
    const chavesAtivas = new Set();
    registro.alvos.clear();
    for (const fonte of fontes) {
        if (fonte.midiaAberta) composto.midiaAberta = true;
        composto.midiaOpenHa = idadeMaisNova(composto.midiaOpenHa, fonte.midiaOpenHa);
        composto.midiaCloseHa = idadeMaisNova(composto.midiaCloseHa, fonte.midiaCloseHa);
        for (const socket of fonte.midiaSockets) {
            if (fonte.origem === 'frame') {
                composto.midiaSockets.push(Object.assign({}, socket));
                continue;
            }
            const chave = fonte._workerSessionId + ':' + socket.id;
            chavesAtivas.add(chave);
            let id = registro.idsPorChave.get(chave);
            if (id === undefined) {
                id = registro.proximoId--;
                registro.idsPorChave.set(chave, id);
            }
            registro.alvos.set(id, { sessionId: fonte._workerSessionId, socketId: socket.id });
            composto.midiaSockets.push(Object.assign({}, socket, { id }));
        }
    }
    for (const chave of registro.idsPorChave.keys()) {
        if (!chavesAtivas.has(chave)) registro.idsPorChave.delete(chave);
    }
    composto.midia = composto.midiaSockets.length;
    return composto;
}

function consultarResumoInstrumentado(win) {
    const wc = win && win.webContents;
    if (!wc) return Promise.resolve(null);
    const pagina = Promise.resolve().then(() => wc.executeJavaScript(
        'window.__goliveGwResumo ? window.__goliveGwResumo() : null', true)).catch(() => null);
    const controle = workerInstrumentacoes.get(wc);
    const workers = controle ? controle.consultar() : Promise.resolve([]);
    return Promise.all([pagina, workers]).then(([frame, resumos]) => comporResumoInstrumentado(win, frame, resumos));
}

function fecharGatewayInstrumentado(win, resumo) {
    const wc = win && win.webContents;
    if (!wc || !resumo || resumo.gatewayAmbiguo === true || resumo.estado !== 'aberta') return Promise.resolve(false);
    if (resumo.origem === 'worker') {
        const controle = workerInstrumentacoes.get(wc);
        if (!controle || !resumo._workerSessionId) return Promise.resolve(false);
        return controle.fecharGateway(resumo._workerSessionId, resumo.geracao);
    }
    // O CDP Network observa sockets que o JS nao expoe, mas esta versao do
    // Chromium nao implementa Network.closeWebSocket. Nunca simular ACK nem
    // escolher outro socket: a escada conservadora decide o fallback.
    if (resumo.origem === 'network') return Promise.resolve(false);
    const geracao = JSON.stringify(Number(resumo.geracao));
    return Promise.resolve().then(() => wc.executeJavaScript(
        '(function(g){var r=window.__goliveGwResumo?window.__goliveGwResumo():null;' +
        'return !!(r&&r.estado==="aberta"&&r.geracao===g&&window.__goliveGwFechar&&window.__goliveGwFechar());})(' + geracao + ')', true))
        .then(Boolean, () => false);
}

function fecharMidiaInstrumentada(win, id) {
    const wc = win && win.webContents;
    if (!wc || !Number.isInteger(id)) return Promise.resolve({ ok: false, id, reason: 'id' });
    if (id >= 0) {
        return Promise.resolve().then(() => wc.executeJavaScript(
            'window.__goliveMidiaFecharId ? window.__goliveMidiaFecharId(' + id + ') : null', true))
            .then(resultado => resultado && resultado.ok === true ? resultado : { ok: false, id, reason: 'ausente' },
                () => ({ ok: false, id, reason: 'close' }));
    }
    const registro = midiaCompostaPorWebContents.get(wc);
    const alvo = registro && registro.alvos.get(id);
    const controle = workerInstrumentacoes.get(wc);
    if (!alvo || !controle) return Promise.resolve({ ok: false, id, reason: 'ausente' });
    return controle.fecharMidia(alvo.sessionId, alvo.socketId)
        .then(ok => ok ? { ok: true, id } : { ok: false, id, reason: 'sem-ack' });
}

function executarVoiceIsolado(win, code) {
    const wc = win && win.webContents;
    if (!wc || typeof wc.executeJavaScriptInIsolatedWorld !== 'function') {
        return Promise.reject(new Error('executeJavaScriptInIsolatedWorld indisponivel'));
    }
    return wc.executeJavaScriptInIsolatedWorld(VOICE_ISOLATED_WORLD_ID, [{ code }], true);
}

function consultarRtcNativo(win) {
    const wc = win && win.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
        return Promise.resolve({ win, voice: null, demanda: null, midia: null, visual: null });
    }
    const voice = executarVoiceIsolado(win,
        'window.__goliveVoiceResumo ? window.__goliveVoiceResumo() : null');
    const pagina = Promise.resolve().then(() => wc.executeJavaScript(
        "({demanda:window.__goliveVoiceDemandaResumo?window.__goliveVoiceDemandaResumo():null," +
        "midia:window.__goliveGwResumo?window.__goliveGwResumo():null," +
        "visual:window.__goliveVideoResumo?window.__goliveVideoResumo():null})", true)).catch(() => null);
    const controle = workerInstrumentacoes.get(wc);
    const workers = controle ? controle.consultar() : Promise.resolve([]);
    return Promise.all([voice, pagina, workers]).then(([voiceResumo, paginaResumo, resumosWorker]) => ({
        win,
        voice: voiceResumo,
        demanda: paginaResumo && paginaResumo.demanda,
        midia: comporResumoInstrumentado(win, paginaResumo && paginaResumo.midia, resumosWorker),
        visual: normalizarResumoVisual(paginaResumo && paginaResumo.visual),
    }));
}

function falharRecuperacaoNativa(ctx, motivo) {
    const stream = streamNativaAtiva(ctx && ctx.voice);
    videoNativoBloqueadoGeracao = stream ? geracaoViewerNativa(ctx, stream) :
        (videoNativoPendente ? videoNativoPendente.geracao : '');
    videoNativoBloqueadoEm = Date.now();
    videoNativoPendente = null;
    log("gw.zumbi | rtc da stream nao recuperou; acao manual (" + motivo + ")");
    if (!videoBannerAtivo) showVideoBanner();
}

function iniciarRecuperacaoNativa(ctx, nivel, geracaoAnterior, sinal) {
    // DESATIVADO: Fechar o socket de midia do WebRTC nativo interrompe o handshake
    // e causa carregamento infinito na camera e transmissao ao vivo do Discord.
    log("gw.revive | rtc stream: socket protegido, fechamento desativado (sinal=" + sinal + ")");
    return;
}

function acompanharRecuperacaoNativa(ctx) {
    const pendente = videoNativoPendente;
    if (!pendente) return false;
    const agora = Date.now();
    const streamSaudavel = rtcNativoSaudavel(ctx, pendente.geracao);
    if (streamSaudavel) {
        if (pendente.sucessoEm === 0) pendente.sucessoEm = agora;
        if (agora - pendente.sucessoEm >= VOICE_SUCESSO_SUSTENTADO_MS) {
            log("gw.revive | rtc stream: sucesso nivel=" + pendente.nivel +
                " geracao_nova=" + streamSaudavel.id + " por=" +
                Math.round((agora - pendente.sucessoEm) / 1000) + "s");
            videoNativoPendente = null;
            videoNativoBloqueadoGeracao = '';
            videoNativoBloqueadoEm = 0;
            hideVideoBanner(ctx.win);
        }
        return true;
    }
    pendente.sucessoEm = 0; // pulso isolado nunca credita a cura

    // O novo addon pode nascer alguns segundos antes de o encoder/receiver
    // assentar. Destrui-lo imediatamente repetiria a corrida que queremos
    // curar; uma geracao realmente nova ganha seu proprio aquecimento.
    const streamAtualAgora = streamNativaAtiva(ctx.voice);
    if (streamAtualAgora && geracaoViewerNativa(ctx, streamAtualAgora) !== pendente.geracao) {
        if (!pendente.renasceuEm) {
            pendente.renasceuEm = agora;
            log("gw.revive | rtc stream: geracao nova nasceu; aguardando video aquecer");
        }
        if (agora - pendente.renasceuEm < VOICE_NOVA_GERACAO_GRACA_MS) return true;
    }

    const demandaAtualStream = demandaRtcDaStream(ctx, streamAtualAgora);
    const decisaoDemanda = decidirDemandaRecuperacao(demandaAtualStream);
    if (decisaoDemanda === 'aguardar') {
        if (!pendente.semDemandaLogada && demandaAtualStream && demandaAtualStream.changedHa >= 15_000) {
            pendente.semDemandaLogada = true;
            log("gw.revive | rtc stream: demanda caiu durante a recuperacao; aguardando sem escalar");
        }
        return true;
    }
    if (decisaoDemanda === 'encerrar') {
        log("gw.revive | rtc stream: observacao encerrada apos 60s sem demanda; sem escalada");
        videoNativoPendente = null;
        return true;
    }
    pendente.semDemandaLogada = false;

    if (agora - pendente.inicioEm < VOICE_NIVEL1_ESPERA_MS) return true;
    // Teste de fogo 01/09: repetir close(4000) no socket substituto recria o
    // WebSocket, mas conserva a mesma stream nativa congelada em fps_out=0.
    // Uma segunda acao so prolonga a pane e pode competir com a outra ponta.
    falharRecuperacaoNativa(ctx, 'nivel1_sem_cura_confirmada');
    return true;
}

function processarRtcNativo(ctx) {
    const agora = Date.now();
    while (videoNativoTentativas.length > 0 && videoNativoTentativas[0] < agora - VOICE_JANELA_MS) {
        videoNativoTentativas.shift();
    }
    if (acompanharRecuperacaoNativa(ctx)) return;
    const stream = streamNativaAtiva(ctx.voice);
    renovarOrcamentoRtc(ctx, stream);
    if (videoNativoBloqueadoEm > 0) {
        const recuperouTarde = rtcNativoSaudavel(ctx, videoNativoBloqueadoGeracao);
        if (recuperouTarde) {
            log("gw.revive | rtc stream: recuperacao tardia comprovada; removendo aviso");
            videoNativoBloqueadoGeracao = '';
            videoNativoBloqueadoEm = 0;
            hideVideoBanner(ctx.win);
        } else if (agora - videoNativoBloqueadoEm >= VOICE_JANELA_MS ||
            (stream && geracaoViewerNativa(ctx, stream) !== videoNativoBloqueadoGeracao)) {
            videoNativoBloqueadoGeracao = '';
            videoNativoBloqueadoEm = 0;
            hideVideoBanner(ctx.win);
        }
    }
    // A leitura de saude e pura; ela vence a via rapida da reentrada. Assim um
    // video que acabou de nascer e ja decodifica nao e fechado por uma amostra
    // de 1s, mas dec=0/fps_dec=0 tambem nao pode apagar a memoria anterior.
    const saudavelAtual = rtcNativoSaudavel(ctx, '');
    const ctxComHistorico = {
        ...ctx,
        viewerSaudavelGeracao: viewerNativoUltimaSaudavelGeracao,
        viewerSaudavelHa: viewerNativoUltimaSaudavelEm > 0 ? agora - viewerNativoUltimaSaudavelEm : -1,
    };
    const sinal = saudavelAtual ? null : avaliarRtcNativo(ctxComHistorico);
    if (saudavelAtual && saudavelAtual.role === 'viewer') {
        // A memoria so nasce de frames realmente recentes e fica para a proxima
        // reentrada. Na #183, atualizar aqui antes da avaliacao fazia uma
        // stream nova com dec=0/fps_dec=0 apagar a ultima stream boa.
        viewerNativoUltimaSaudavelGeracao = geracaoViewerNativa(ctx, saudavelAtual);
        viewerNativoUltimaSaudavelEm = agora;
    }
    if (!sinal) {
        return;
    }
    if (stream && geracaoViewerNativa(ctx, stream) === videoNativoBloqueadoGeracao) return;
    if (videoNativoUltimaAcaoEm > 0 && agora - videoNativoUltimaAcaoEm < VOICE_ACAO_COOLDOWN_MS) return;
    iniciarRecuperacaoNativa(ctx, 1, '', sinal);
}

function logRtcNativo(ctx) {
    const agora = Date.now();
    const stream = streamNativaAtiva(ctx.voice);
    const stats = stream && stream.stats;
    const socket = socketMidiaDaStream(ctx, stream);
    const demanda = demandaRtcDaStream(ctx, stream);
    const assinatura = [
        !!(ctx.voice && ctx.voice.voiceHooked), stream ? stream.id : 0,
        !!(demanda && demanda.active), stats ? !!stats.statsOk : false,
        stream ? stream.role : '', stats ? stats.direction : '',
        stats ? stats.videoPresent : '', socket ? socket.id : 0,
        videoNativoPendente ? videoNativoPendente.nivel : 0,
    ].join(':');
    if (assinatura === voiceProbeUltimaAssinatura && agora - voiceProbeUltimoLogEm < VOICE_PROBE_LOG_MS) return;
    voiceProbeUltimaAssinatura = assinatura;
    voiceProbeUltimoLogEm = agora;
    log("voice.probe | hook=" + (ctx.voice && ctx.voice.voiceHooked ? "sim" : "nao") +
        " stream=" + (stream ? stream.id : "nenhuma") +
        " papel=" + (stream ? (stream.role || "?") : "?") +
        " socket=" + (socket ? socket.id : "?") +
        " fonte=" + (ctx.voice && ctx.voice.sourceReady ? "sim" : "nao") +
        " demanda=" + (demanda && demanda.known ? (demanda.active ? (demanda.recentOnly ? "recente" : "sim") : "nao") : "?") +
        " demanda_ha=" + idadeSeg(demanda ? demanda.demandHa : -1) +
        " entrada_ha=" + idadeSeg(stats ? stats.entradaHa : -1) +
        " saida_ha=" + idadeSeg(stats ? stats.saidaHa : -1) +
        " video=" + (stats && stats.direction === 'inbound' ? (stats.videoPresent ? "sim" : "nao") : "?") +
        " video_ha=" + idadeSeg(stats ? stats.videoHa : -1) +
        " fps_in=" + (stats && typeof stats.inputFrameRate === 'number' ? Math.round(stats.inputFrameRate) : "?") +
        " fps_out=" + (stats && typeof stats.encodeFrameRate === 'number' ? Math.round(stats.encodeFrameRate) : "?") +
        " fps_dec=" + (stats && typeof stats.decodeFrameRate === 'number' ? Math.round(stats.decodeFrameRate) : "?") +
        " frames=" + (stats && typeof stats.framesEncoded === 'number' ? Math.round(stats.framesEncoded) : "?") +
        " dec=" + (stats && typeof stats.framesDecoded === 'number' ? Math.round(stats.framesDecoded) : "?") +
        " target=" + (stats && typeof stats.targetMediaBitrate === 'number' ? Math.round(stats.targetMediaBitrate) : "?") +
        " rtt=" + (stats && typeof stats.transportRtt === 'number' ? Math.round(stats.transportRtt) : "?") +
        " feedback_ha=" + idadeSeg(stats ? stats.transportHa : -1) +
        " stats=" + (stats && stats.statsOk ? "ok" : (stats && stats.reason ? stats.reason : "?")));
}

function checarRtcNativo() {
    if (voiceProbeRodando) return;
    const janelas = janelasCliente();
    if (janelas.length === 0) return;
    voiceProbeRodando = true;
    const epoca = voiceProbeEpoca;
    Promise.all(janelas.map(win => consultarRtcNativo(win).catch(error => ({ win, error })))).then(resultados => {
        if (epoca !== voiceProbeEpoca) return;
        let escolhido = null;
        for (const resultado of resultados) {
            if (!resultado || resultado.error || !resultado.voice) continue;
            if (escolhido === null || (streamNativaAtiva(resultado.voice) && !streamNativaAtiva(escolhido.voice))) {
                escolhido = resultado;
            }
        }
        if (escolhido === null) {
            if (!voiceIsolatedAvisado) {
                voiceIsolatedAvisado = true;
                const erro = resultados.find(r => r && r.error);
                log("voice.probe | mundo isolado indisponivel" + (erro ? ": " + erro.error.message : ""));
            }
            return;
        }
        voiceIsolatedAvisado = false;
        // webRequest marca o handshake, mas uma Live longa pode manter o mesmo
        // websocket de *.discord.media por dezenas de minutos. Alem disso, no
        // viewer o socket pode deixar de aparecer ao shim enquanto discord_voice
        // ainda decodifica video normalmente (#178). Uma stream nativa ativa e
        // portanto sinal autoritativo para manter a guarda de reload/troca viva.
        const stream = streamNativaAtiva(escolhido.voice);
        if ((escolhido.midia && escolhido.midia.midiaAberta === true) || stream !== null) {
            marcarMidiaProtegida();
        }
        if (!voiceHookLogado && escolhido.voice.voiceHooked === true) {
            voiceHookLogado = true;
            log("voice.hook | discord_voice interceptado no preload isolado");
        }
        const geracao = stream ? geracaoNativa(escolhido.voice, stream) : '';
        if (stream && geracao !== voiceUltimaGeracaoLogada) {
            voiceUltimaGeracaoLogada = geracao;
            log("voice.conn | tipo=stream geracao=" + stream.id + " estado=ativa");
        }
        logRtcNativo(escolhido);
        processarRtcNativo(escolhido);
    }).catch(error => {
        log("voice.probe | falha no vigia nativo: " + error.message);
    }).finally(() => {
        if (epoca === voiceProbeEpoca) voiceProbeRodando = false;
    });
}

function idadeSeg(ha) {
    return typeof ha !== 'number' || !Number.isFinite(ha) || ha < 0 ? "?" : Math.round(ha / 1000) + "s";
}

function reloadPorRevive(motivo) {
    if (reloading) return;
    const win = clientWindow();
    if (win === null) return;
    // So LIA o mutex antes desta linha (nunca escrevia): maybeReloadAfterDirect() e
    // maybeReloadAfterColdHold() (que escrevem o mesmo `reloading`) viam sempre false e podiam
    // disparar um SEGUNDO win.webContents.reload() na mesma janela enquanto este ainda estava
    // navegando -- dois reloads concorrentes interrompendo um ao outro, alcancavel de verdade
    // numa sessao com Tor caindo e gateway zumbi ao mesmo tempo (a mesma rede ruim motiva os
    // dois gatilhos). watchReloads() zera de volta assim que a navegacao de verdade comeca
    // (did-start-loading), o mesmo sinal que ja limpa o resto do estado de revive/zumbi.
    reloading = true;
    log("gw.revive | recarregando a janela (" + motivo + ")");
    win.webContents.reload();
}

function vigiarZumbi(resumo, win) {
    const agora = Date.now();
    if (resumo.gatewayAmbiguo === true) {
        if (!zumbiBannerAtivo) {
            log('gw.zumbi | mais de um gateway aberto no mesmo webContents; somente diagnostico');
            zumbiBannerAtivo = true;
            showZumbiBanner();
        }
        return;
    }
    const decisao = decidirRevive({
        agora,
        midiaAberta: resumo.midiaAberta === true,
        midiaRecente: agora - ultimaMidiaEm < GW_REVIVE_MIDIA_GRACA_MS,
        tentativas: zumbiTentativaEm,
        ultimaAcaoEm: zumbiUltimaAcaoEm,
        ultimaAcao: zumbiUltimaAcao
    });
    if (decisao.acao === 'nenhum') return;
    if (decisao.acao === 'banner') {
        // Ambiental: em call/midia recente (§6) ou teto de tentativas estourado — o usuario decide.
        if (!zumbiBannerAtivo) {
            log("gw.zumbi | confirmado mas acao manual (" + decisao.motivo + "): dispatches=" +
                resumo.dispatches + " intent_ha=" + idadeSeg(resumo.intentHa));
            zumbiBannerAtivo = true;
            showZumbiBanner();
        }
        return;
    }
    zumbiTentativaEm.push(agora);
    zumbiUltimaAcaoEm = agora;
    zumbiUltimaAcao = decisao.acao;
    sessaoRevives++;
    if (decisao.acao === 'fechar') {
        log("gw.revive | nivel=1: fechando o ws do gateway (close 4000) para o cliente renascer com RESUME" +
            " (dispatches=" + resumo.dispatches + " intent_ha=" + idadeSeg(resumo.intentHa) + ")");
        reviveFecharEm = agora;
        reviveFecharGeracao = resumo.geracao;
        reviveFecharOrigem = String(resumo.origem || 'frame') + ':' + String(resumo.workerId || '');
        revivePendenteEm = agora;
        fecharGatewayInstrumentado(win, resumo)
            .then(ok => {
                if (ok !== true) log("gw.revive | nao consegui fechar o ws (shim ausente ou ws nao aberto)");
            })
            .catch(error => log("gw.revive | falhei ao fechar o ws: " + error.message));
        setTimeout(() => {
            if (reviveFecharEm === agora) checarGatewaySilente();
        }, GW_REVIVE_RENASCE_MS + 500);
    } else {
        log("gw.revive | nivel=2: o close nao curou (dispatches=" + resumo.dispatches + "), recarregando a janela");
        reviveFecharEm = 0;
        reloadPorRevive("zumbi persiste apos o close");
    }
}

function checarGatewaySilente() {
    if (gatewayProbeRodando) {
        gatewayProbeRepetir = true;
        return Promise.resolve(false);
    }
    const janelas = janelasCliente();
    if (janelas.length === 0) return Promise.resolve(false);
    gatewayProbeRodando = true;
    const epoca = gatewayProbeEpoca;
    const inicio = Date.now();
    const polls = janelas.map(win => {
        const wc = win.webContents;
        const bloqueadoAte = gatewayProbeBloqueadoAte.get(wc) || 0;
        if (bloqueadoAte > inicio) return Promise.resolve({ win, resumo: null, ignorado: true });
        const consulta = consultarResumoInstrumentado(win);
        return prazoCdp(consulta, GW_PROBE_TIMEOUT_MS, 'probe renderer')
            .then(resumo => ({ win, resumo, ignorado: false }))
            .catch(error => {
                if (String(error && error.message || error).indexOf('excedeu') !== -1) {
                    gatewayProbeBloqueadoAte.set(wc, Date.now() + GW_PROBE_COOLDOWN_TIMEOUT_MS);
                    log('gw.probe | timeout no renderer id=' + (wc.id || '?') +
                        '; janela em cooldown por ' + Math.round(GW_PROBE_COOLDOWN_TIMEOUT_MS / 60000) + 'min');
                }
                return { win, resumo: null, ignorado: false };
            });
    });
    return Promise.allSettled(polls).then(concluidos => {
        if (epoca !== gatewayProbeEpoca) return false;
        const resultados = concluidos
            .filter(item => item.status === 'fulfilled')
            .map(item => item.value);
        const agora = Date.now();
        // Escolhe o resumo mais util: janela com gateway de preferencia (a #154
        // provou que pode haver mais de uma janela de cliente, nem toda com shim).
        let resumo = null;
        let winResumo = null;
        for (const r of resultados) {
            if (!r.resumo) continue;
            if (resumo === null || (r.resumo.estado !== 'nenhum' && resumo.estado === 'nenhum')) {
                resumo = r.resumo;
                winResumo = r.win;
            }
        }
        if (resumo === null) {
            // Silencio diagnosticavel: a #154 passou 3 minutos sem NENHUMA linha de
            // probe porque o resumo ausente era engolido aqui.
            if (resultados.some(r => r.ignorado !== true)) {
                log("gw.probe | estado=sem-shim: nenhuma janela do cliente respondeu ao probe");
            }
            return false;
        }
        log("gw.probe | estado=" + resumo.estado +
            " origem=" + (resumo.origem || "frame") +
            " srv_ha=" + idadeSeg(resumo.srvHa) +
            " cli_ha=" + idadeSeg(resumo.cliHa) +
            " subs=" + resumo.subs +
            " srv_frames=" + resumo.srvFrames +
            " dispatch_ha=" + idadeSeg(resumo.dispatchHa) +
            " dispatches=" + resumo.dispatches +
            " intent_ha=" + idadeSeg(resumo.intentHa) +
            " activity_ha=" + idadeSeg(resumo.activityHa) +
            " op4_ha=" + idadeSeg(resumo.op4Ha) +
            " midia_open_ha=" + idadeSeg(resumo.midiaOpenHa) +
            " midia_close_ha=" + idadeSeg(resumo.midiaCloseHa) +
            " aberto_ha=" + idadeSeg(resumo.abertoHa) +
            " geracao=" + resumo.geracao +
            " ops=" + JSON.stringify(resumo.opCounts || {}) +
            " resp_bytes=" + resumo.srvBytesDesdeAtividade +
            (resumo.infladorOk === false ? " (sem decompress)" : ""));
        // Auto-cura do nivel 1: fechamos o ws e o cliente NAO renasceu a conexao —
        // o close nao surtiu; sobe direto pro reload (a cura que sempre funciona).
        if (reviveFecharEm > 0) {
            const origemAtual = String(resumo.origem || 'frame') + ':' + String(resumo.workerId || '');
            if (resumo.estado === 'aberta' &&
                (resumo.geracao !== reviveFecharGeracao || origemAtual !== reviveFecharOrigem)) {
                reviveFecharEm = 0; // renasceu: a escada segue do ponto certo
                reviveFecharOrigem = '';
            } else if (agora - reviveFecharEm > GW_REVIVE_RENASCE_MS) {
                log("gw.revive | o ws nao renasceu apos o close, subindo direto pro reload");
                reviveFecharEm = 0;
                reviveFecharOrigem = '';
                zumbiTentativaEm.push(agora);
                zumbiUltimaAcaoEm = agora;
                zumbiUltimaAcao = 'reload';
                sessaoRevives++;
                reloadPorRevive("ws nao renasceu apos o close");
                return true;
            }
        }
        const sinal = avaliarSinalGw(resumo, agora);
        if (sinal === 'zumbi') {
            vigiarZumbi(resumo, winResumo);
            return true;
        }
        if (sinal === 'silente') {
            if (!zumbiBannerAtivo) { zumbiBannerAtivo = true; showZumbiBanner(); }
            return true;
        }
        // Recuperacao: remover o banner e creditar a escada. O credito so vale com a
        // conexao SOBREVIVENDO ao aquecimento com dado fluindo — senao o READY da
        // conexao nova (que sempre chega) creditaria sucesso a um revive que nao curou.
        const servidorFalando = resumo.estado === 'aberta' && resumo.srvHa >= 0 && resumo.srvHa < GW_SERVIDOR_SILENCIOSO_MS;
        const dadoFluindo = resumo.dispatchHa >= 0 && resumo.dispatchHa < 60_000;
        if (zumbiBannerAtivo && servidorFalando && (dadoFluindo || resumo.infladorOk !== true)) {
            hideZumbiBanner();
            log("gateway voltou a responder: banner de sessao muda removido");
        }
        if (zumbiTentativaEm.length > 0 && servidorFalando && dadoFluindo &&
            resumo.abertoHa >= GW_ZUMBI_AQUECIMENTO_MS) {
            log("gw.revive | sucesso: dispatches voltaram apos " + zumbiTentativaEm.length + " tentativa(s)");
            zumbiTentativaEm.length = 0;
            zumbiUltimaAcaoEm = 0;
            zumbiUltimaAcao = null;
        }
        // A midia nativa e observada por checarRtcNativo() em um intervalo
        // proprio de 5s. O antigo RTCPeerConnection do Chromium continua no
        // shim apenas como diagnostico legado, mas nao participa de decisoes.
        return true;
    }).catch(error => {
        log('gw.probe | falha interna: ' + error.message);
        return false;
    }).finally(() => {
        gatewayProbeRodando = false;
        if (gatewayProbeRepetir) {
            gatewayProbeRepetir = false;
            setTimeout(() => { checarGatewaySilente(); }, 0);
        }
    });
}

// Shim + pill: prender em TODO webContents novo (o Discord recria janelas e
// recarrega o tempo todo). O shim vai via CDP — addScriptToEvaluateOnNewDocument
// roda antes do primeiro script da pagina, a unica forma garantida de envolver o
// WebSocket antes do cliente do gateway nascer. O pill vai no did-finish-load
// (DOM pronto) e reinjeta a cada recarga.
function prazoCdp(promessa, ms, rotulo) {
    return new Promise((resolver, rejeitar) => {
        let encerrado = false;
        const timer = setTimeout(() => {
            if (encerrado) return;
            encerrado = true;
            rejeitar(new Error(rotulo + " excedeu " + ms + "ms"));
        }, ms);
        Promise.resolve(promessa).then(valor => {
            if (encerrado) return;
            encerrado = true;
            clearTimeout(timer);
            resolver(valor);
        }, error => {
            if (encerrado) return;
            encerrado = true;
            clearTimeout(timer);
            rejeitar(error);
        });
    });
}

function injetarInstrumentacao(wc) {
    const workerShimSrc = SHIM_WORKER_SRC;
    const paginaShimSrc = SHIM_GATEWAY_SRC + '\n' + SHIM_VOICE_SRC;
    const depurador = wc.debugger;
    const targets = new Map();
    const anexos = new Set();
    let workersInjetados = 0;
    let cdpAtivo = false;
    let rearmando = false;
    let consultaRodando = null;
    let limiteLogado = false;
    // Fonte primaria de telemetria do gateway. O dominio Network pertence ao
    // Chromium e recebe o websocket mesmo quando o Discord o cria por uma
    // abstracao nativa, antes do preload, ou fora dos workers JS enumeraveis.
    // requestId so tem significado junto do sessionId CDP e nunca sai desta
    // closure/webContents.
    const rede = {
        geracao: 0, gateway: null, midia: new Map(),
        midiaAbertaEm: 0, midiaFechouEm: 0, cliEnvios: [],
    };

    const comandoCdp = (metodo, parametros, sessaoId) => {
        try {
            // Enfileira no CDP ainda dentro de web-contents-created; adiar para
            // microtask reabriria uma corrida com o primeiro Worker do bundle.
            return Promise.resolve(depurador.sendCommand(metodo, parametros || {}, sessaoId));
        } catch (error) {
            return Promise.reject(error);
        }
    };
    const avaliarWorker = (sessaoId, expressao, ms) => prazoCdp(comandoCdp('Runtime.evaluate', {
        expression: expressao, returnByValue: true, silent: true,
    }, sessaoId), ms, 'Runtime.evaluate worker').then(resultado => {
        if (resultado && resultado.exceptionDetails) throw new Error('worker recusou Runtime.evaluate');
        return resultado && resultado.result ? resultado.result.value : undefined;
    });
    const liberarWorker = (sessaoId, tentativa) => {
        const n = tentativa || 1;
        return prazoCdp(comandoCdp('Runtime.runIfWaitingForDebugger', {}, sessaoId), 2000,
            'release worker tentativa ' + n).catch(error => {
                if (n < 3) {
                    return new Promise(resolve => setTimeout(resolve, 100 * n))
                        .then(() => liberarWorker(sessaoId, n + 1));
                }
                log('gw.worker | CRITICO: falha ao liberar worker apos 3 tentativas: ' + error.message);
                return comandoCdp('Target.detachFromTarget', { sessionId: sessaoId }).catch(() => { });
            });
    };

    const chaveRede = (sessaoId, requestId) => String(sessaoId || 'root') + ':' + String(requestId || '');
    const idadeRede = (agora, em) => em > 0 ? agora - em : -1;
    const resumoRede = () => {
        const agora = Date.now();
        const gw = rede.gateway;
        return {
            origem: 'network', workerId: '', geracao: rede.geracao,
            estado: gw ? gw.estado : 'nenhum',
            srvHa: idadeRede(agora, gw && gw.srvEm),
            cliHa: idadeRede(agora, gw && gw.cliEm),
            abertoHa: idadeRede(agora, gw && gw.abertoEm),
            srvFrames: gw ? gw.srvFrames : 0,
            srvBytes: gw ? gw.srvBytes : 0,
            srvBytesDesdeAtividade: gw ? gw.srvBytesDesdeAtividade : 0,
            cliEnvios: gw ? gw.cliEnvios : 0,
            dispatches: gw ? gw.dispatches : 0,
            dispatchHa: idadeRede(agora, gw && gw.dispatchEm),
            intentHa: idadeRede(agora, gw && gw.intentEm),
            activityHa: idadeRede(agora, gw && gw.activityEm),
            op4Ha: idadeRede(agora, gw && gw.op4Em),
            subs: gw ? gw.subs : 0,
            opCounts: gw ? Object.assign({}, gw.opCounts) : {},
            infladorOk: false,
            midia: rede.midia.size, midiaAberta: rede.midia.size > 0,
            midiaOpenHa: idadeRede(agora, rede.midiaAbertaEm),
            midiaCloseHa: idadeRede(agora, rede.midiaFechouEm),
            // Network nao oferece close por requestId neste Chromium. Nao
            // fabricar ids acionaveis preserva o fail-closed do revive RTC.
            midiaSockets: [], pcs: 0,
        };
    };
    const limparSessaoRede = sessaoId => {
        const prefixo = String(sessaoId || 'root') + ':';
        for (const chave of rede.midia.keys()) {
            if (chave.startsWith(prefixo)) rede.midia.delete(chave);
        }
        if (rede.gateway && rede.gateway.sessionId === String(sessaoId || '')) {
            rede.gateway.estado = 'fechada';
        }
    };
    const eventoRede = (metodo, parametros, sessaoId) => {
        if (!parametros || !parametros.requestId) return;
        const sid = String(sessaoId || '');
        const chave = chaveRede(sid, parametros.requestId);
        if (metodo === 'Network.webSocketCreated') {
            let host = '';
            try { host = new URL(String(parametros.url || '')).hostname; } catch { return; }
            if (/(^|\.)gateway(-[a-z0-9-]+)?\.discord\.gg$/.test(host)) {
                rede.geracao++;
                rede.cliEnvios = [];
                rede.gateway = {
                    chave, sessionId: sid, requestId: String(parametros.requestId), estado: 'conectando',
                    criadoEm: Date.now(), abertoEm: 0, srvEm: 0, cliEm: 0,
                    srvFrames: 0, srvBytes: 0, srvBytesDesdeAtividade: 0,
                    cliEnvios: 0, dispatches: 0, dispatchEm: 0,
                    intentEm: 0, activityEm: 0, op4Em: 0, subs: 0, opCounts: {},
                };
            } else if (/(^|\.)discord\.media$/.test(host)) {
                // Limite defensivo por janela; conexoes fechadas saem no
                // evento correspondente e extras ainda deixam a guarda ativa.
                if (rede.midia.size < 64) rede.midia.set(chave, { sessionId: sid, criadoEm: Date.now() });
            }
            return;
        }
        const gw = rede.gateway && rede.gateway.chave === chave ? rede.gateway : null;
        if (metodo === 'Network.webSocketHandshakeResponseReceived') {
            if (gw) { gw.estado = 'aberta'; gw.abertoEm = Date.now(); }
            const media = rede.midia.get(chave);
            if (media) { media.abertoEm = Date.now(); rede.midiaAbertaEm = media.abertoEm; }
            return;
        }
        if (metodo === 'Network.webSocketFrameSent' && gw) {
            const agora = Date.now();
            const resposta = parametros.response || {};
            const payload = typeof resposta.payloadData === 'string' ? resposta.payloadData : '';
            let op = -1;
            gw.cliEm = agora;
            gw.cliEnvios++;
            rede.cliEnvios.push(agora);
            while (rede.cliEnvios.length > 0 && rede.cliEnvios[0] < agora - 30_000) rede.cliEnvios.shift();
            if (rede.cliEnvios.length >= 3) {
                gw.activityEm = agora;
                gw.srvBytesDesdeAtividade = 0;
            }
            if (resposta.opcode === 1) {
                try { op = JSON.parse(payload).op; } catch { }
            } else if (resposta.opcode === 2) op = opEtfCdp(payload);
            if (op === 1 || op === 4 || op === 14 || op === 18 || op === 19 ||
                op === 20 || op === 21 || op === 22 || op === 37) {
                gw.opCounts[op] = (gw.opCounts[op] || 0) + 1;
                if (op !== 1 && op !== 19 && op !== 21) gw.intentEm = agora;
                if (op === 4 || op === 18 || op === 20) gw.op4Em = agora;
                if (op === 14 || op === 37) gw.subs++;
            }
            return;
        }
        if (metodo === 'Network.webSocketFrameReceived' && gw) {
            const agora = Date.now();
            const resposta = parametros.response || {};
            const payload = typeof resposta.payloadData === 'string' ? resposta.payloadData : '';
            let tamanho = 0;
            try {
                tamanho = resposta.opcode === 2
                    ? Buffer.byteLength(payload, 'base64') : Buffer.byteLength(payload, 'utf8');
            } catch { }
            gw.srvEm = agora;
            gw.srvFrames++;
            gw.srvBytes += tamanho;
            gw.srvBytesDesdeAtividade += tamanho;
            if (resposta.opcode === 1) {
                try {
                    const pacote = JSON.parse(payload);
                    if (pacote && pacote.op === 0) { gw.dispatches++; gw.dispatchEm = agora; }
                } catch { }
            }
            return;
        }
        if (metodo === 'Network.webSocketClosed') {
            if (gw) gw.estado = 'fechada';
            if (rede.midia.delete(chave)) rede.midiaFechouEm = Date.now();
        }
    };

    const controle = {
        consultar() {
            if (!cdpAtivo) return Promise.resolve([]);
            if (consultaRodando) return consultaRodando;
            const probes = Array.from(targets.entries()).map(([sessionId, meta]) =>
                avaliarWorker(sessionId, 'self.__goliveWorkerResumo ? self.__goliveWorkerResumo() : null', 2500)
                    .then(valor => normalizarResumoInstrumentado(valor, 'worker', sessionId, meta.instaladoEm))
                    .catch(error => {
                        if (!meta.falhaLogada) {
                            meta.falhaLogada = true;
                            log('gw.worker | probe falhou em target ativo: ' + error.message);
                        }
                        return null;
                    }));
            consultaRodando = Promise.allSettled(probes)
                .then(resultados => {
                    const saida = resultados.filter(item => item.status === 'fulfilled').map(item => item.value).filter(Boolean);
                    const resumo = normalizarResumoInstrumentado(resumoRede(), 'network', '', 0);
                    if (resumo) saida.push(resumo);
                    return saida;
                })
                .finally(() => { consultaRodando = null; });
            return consultaRodando;
        },
        fecharGateway(sessionId, geracao) {
            if (!cdpAtivo || !targets.has(sessionId) || !Number.isInteger(geracao)) return Promise.resolve(false);
            return avaliarWorker(sessionId,
                'self.__goliveWorkerFecharGateway ? self.__goliveWorkerFecharGateway(' + JSON.stringify(geracao) + ') : false', 2500)
                .then(valor => valor === true, () => false);
        },
        fecharMidia(sessionId, socketId) {
            if (!cdpAtivo || !targets.has(sessionId) || !Number.isInteger(socketId)) return Promise.resolve(false);
            return avaliarWorker(sessionId,
                'self.__goliveWorkerFecharMidia ? self.__goliveWorkerFecharMidia(' + JSON.stringify(socketId) + ') : false', 2500)
                .then(valor => valor === true, () => false);
        },
    };
    workerInstrumentacoes.set(wc, controle);

    depurador.on('message', (_evento, metodo, parametros, sessaoMensagem) => {
        if (metodo.startsWith('Network.webSocket')) {
            eventoRede(metodo, parametros, sessaoMensagem);
            return;
        }
        if (!parametros || !parametros.sessionId) return;
        const sessaoId = parametros.sessionId;
        if (metodo === 'Target.detachedFromTarget') {
            anexos.delete(sessaoId);
            targets.delete(sessaoId);
            limparSessaoRede(sessaoId);
            return;
        }
        if (metodo !== 'Target.attachedToTarget') return;
        anexos.add(sessaoId);
        const info = parametros.targetInfo || {};
        const ehWorker = info.type === 'worker' || info.type === 'shared_worker';
        if (!ehWorker) {
            comandoCdp('Network.enable', {}, sessaoId).catch(() => { });
            liberarWorker(sessaoId, 1).catch(() => { });
            return;
        }
        if (targets.size >= 32) {
            if (!limiteLogado) {
                limiteLogado = true;
                log('gw.worker | limite de 32 targets atingido; extras ficam sem telemetria');
            }
            liberarWorker(sessaoId, 1).catch(() => { });
            return;
        }
        comandoCdp('Network.enable', {}, sessaoId).catch(() => { });
        avaliarWorker(sessaoId, workerShimSrc, 4000)
            .then(() => {
                if (!anexos.has(sessaoId)) return;
                targets.set(sessaoId, { instaladoEm: Date.now(), falhaLogada: false });
                workersInjetados++;
                log('gw.worker | shim injetado ' +
                    (parametros.waitingForDebugger === true ? 'antes do start' : 'tardiamente') +
                    ' n=' + workersInjetados + ' tipo=' + info.type);
            })
            .catch(error => log('gw.worker | falha ao injetar: ' + error.message))
            .finally(() => { liberarWorker(sessaoId, 1).catch(() => { }); });
    });
    depurador.on('detach', (_evento, motivo) => {
        cdpAtivo = false;
        targets.clear();
        anexos.clear();
        rede.gateway = null;
        rede.midia.clear();
        midiaCompostaPorWebContents.delete(wc);
        try {
            if (!wc.isDestroyed()) log('gw.worker | debugger desacoplado: ' + motivo + '; acoes em worker desativadas');
        } catch { return; }
        if (!wc.isDevToolsOpened()) setTimeout(() => { armarCdp(); }, 1000);
    });

    function armarCdp() {
        if (rearmando || wc.isDestroyed()) return;
        rearmando = true;
        try {
            if (!depurador.isAttached()) depurador.attach('1.3');
            cdpAtivo = true;
        } catch (error) {
            cdpAtivo = false;
            rearmando = false;
            log('gw.worker | debugger indisponivel: ' + error.message);
            return;
        }
        comandoCdp('Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
            filter: [
                { type: 'worker', exclude: false },
                { type: 'shared_worker', exclude: false },
                { exclude: true },
            ],
        }).catch(error => {
            log('gw.worker | filtro de auto-attach indisponivel, usando compatibilidade: ' + error.message);
            return comandoCdp('Target.setAutoAttach', {
                autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
            });
        }).then(() => log('gw.worker | auto-attach armado antes dos novos workers'))
            .catch(error => {
                cdpAtivo = false;
                log('gw.worker | auto-attach indisponivel: ' + error.message);
            }).finally(() => { rearmando = false; });
        comandoCdp('Network.enable').catch(error => log('gw.network | Network.enable falhou: ' + error.message));
        comandoCdp('Page.enable').catch(error => log('gw.shim | Page.enable falhou: ' + error.message));
        comandoCdp('Page.addScriptToEvaluateOnNewDocument', { source: paginaShimSrc })
            .catch(error => log('gw.shim | preload CDP da pagina falhou: ' + error.message));
    }
    wc.on('devtools-closed', () => { setTimeout(() => { armarCdp(); }, 250); });
    wc.once('destroyed', () => {
        cdpAtivo = false;
        targets.clear();
        workerInstrumentacoes.delete(wc);
        midiaCompostaPorWebContents.delete(wc);
    });
    armarCdp();
    // Fallback no mundo principal. dom-ready e mais cedo que did-finish-load,
    // mas nao garante preceder os scripts da pagina; a garantia dos workers e
    // o auto-attach pausado acima.
    wc.on('dom-ready', () => {
        try {
            let url = '';
            try { url = wc.getURL(); } catch { return; }
            if (!CLIENT_URL_RE.test(url)) return;
            wc.executeJavaScript('({ gateway: !!window.__goliveGwShim, voice: !!window.__goliveVoiceShim })')
                .then(shims => {
                    let fonte = '';
                    if (!shims || shims.gateway !== true) fonte += SHIM_GATEWAY_SRC + '\n';
                    if (!shims || shims.voice !== true) fonte += SHIM_VOICE_SRC;
                    if (fonte === '') return;
                    log("gw.shim | fallback no dom-ready (gateway=" + !!(shims && shims.gateway) +
                        " voice=" + !!(shims && shims.voice) + ")");
                    return wc.executeJavaScript(fonte);
                })
                .then(() => { wc.executeJavaScript(REVIVE_SRC).catch(() => { }); })
                .catch(() => { });
        } catch { }
    });
    wc.on('did-finish-load', () => {
        try {
            let url = '';
            try { url = wc.getURL(); } catch { return; }
            if (!CLIENT_URL_RE.test(url)) return;
            // Fallback do shim (issue #154: sessao inteira sem probe — o
            // addScriptToEvaluateOnNewDocument pode nao anexar em alguma janela). O
            // shim se auto-guarda (__goliveGwShim), entao reinjetar aqui e no-op
            // quando ele ja vive; quando nao vive, entra em linha e cobre as
            // reconexoes seguintes (a conexao corrente, se existir, so e coberta
            // no proximo reconnect do cliente).
            wc.executeJavaScript('({ gateway: !!window.__goliveGwShim, voice: !!window.__goliveVoiceShim })')
                .then(shims => {
                    let fonte = '';
                    if (!shims || shims.gateway !== true) fonte += SHIM_GATEWAY_SRC + '\n';
                    if (!shims || shims.voice !== true) fonte += SHIM_VOICE_SRC;
                    if (fonte === '') return;
                    log("gw.shim | shim ausente neste documento, reinjetando no did-finish-load" +
                        " (gateway=" + !!(shims && shims.gateway) +
                        " voice=" + !!(shims && shims.voice) + ")");
                    return wc.executeJavaScript(fonte);
                })
                .then(() => { wc.executeJavaScript(REVIVE_SRC).catch(() => { }); })
                .catch(() => { });
        } catch { }
    });
}

app.on("web-contents-created", (_evento, wc) => {
    try { injetarInstrumentacao(wc); } catch (error) { log(error.message); }
});
// === gateway: probe no renderer + pill de recuperacao: fim ===

function markGatewayRouted() {
    lastRoutedAt = Date.now();
    ativaEntregouEm = Date.now();
    sessaoRoteadas++;
    if (reloadCount > 0) {
        // A recarga que foi disparada (maybeReloadAfterDirect) acabou de renascer:
        // mede o tempo entre o disparo (lastReloadAt) e este roteado.
        const levou = lastReloadAt === 0 ? "?" : (Date.now() - lastReloadAt) + "ms";
        log("recarga.renasceu | levou=" + levou +
            " saida=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
        sessaoReloads++;
    }
    reloadCount = 0;

    gatewayConnCount++;
    const vistoHa = ultimoVistoAt === 0 ? -1 : Date.now() - ultimoVistoAt;
    log("gw.roteado | n_sessao=" + gatewayConnCount +
        " visto_ha=" + (vistoHa < 0 ? "?" : vistoHa + "ms") +
        " saida=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
    if (revivePendenteEm > 0 && Date.now() - revivePendenteEm < GW_REVIVE_TTL_MS) {
        // Esta conexao foi provocada pelo NOSSO revive (close 4000): nao e recorrencia,
        // e a cura chegando. Sem aviso, sem auto-reload; a sessao recomeca a contar.
        log("gw.revive | reconexao do revive chegou: sessao renasce limpa");
        revivePendenteEm = 0;
        gatewayConnCount = 1;
    } else if (gatewayConnCount > 1) {
        const comMidia = Date.now() - ultimaMidiaEm < MIDIA_RECENTE_MS;
        log("gateway reconectou no meio da sessao (recorrencia " + (gatewayConnCount - 1) + ")"
            + (comMidia ? ": avisando na tela" : ", sem chamada em andamento"));
        if (comMidia) {
            showReconnectWarning(gatewayConnCount - 1);
            agendarReassistirViewer();
        }
        else autoReloadForCleanEngine(gatewayConnCount - 1);
    }
    agendarEstat();
}

// Aviso visual DENTRO do Discord (nao um dialogo do sistema): um elemento nosso, flutuante,
// injetado via CDP. Nao mexe em nada do Discord, so soma um div — furtivo o bastante para nao
// atrapalhar a transmissao, visivel o bastante para a pessoa perceber e decidir.
const WARN_BANNER_TEXT = "GoLiveBypass: o gateway reconectou no meio da sessao. Se o video da " +
    "sua transmissao travou (ficou so o audio), clique em \"Reiniciar agora\" abaixo (ou " +
    "Ctrl+R) -- isso sai da chamada de voz.";

// Uma queda total de gateway pode fazer o Discord abandonar a inscricao da
// Live, apesar de a chamada voltar. O shim so permite este clique quando viu
// video com frames recentes NO fechamento do gateway; por isso nao reassiste
// uma Live que a pessoa parou voluntariamente. O botao pode levar alguns
// segundos para aparecer depois do READY, entao esperamos no maximo 15s e
// fazemos uma tentativa unica. Sem prova/botao/localizacao conhecida, falha
// fechado e preserva o aviso manual normal.
const REASSISTIR_TENTATIVAS = 15;
const REASSISTIR_INTERVALO_MS = 1_000;
const reassistirPorWebContents = new WeakMap();

function agendarReassistirViewer() {
    const win = clientWindow();
    const wc = win && win.webContents;
    if (!wc || reassistirPorWebContents.has(wc)) return;
    const estado = { tentativa: 0, timer: null };
    reassistirPorWebContents.set(wc, estado);
    const tentar = () => {
        if (reassistirPorWebContents.get(wc) !== estado || wc.isDestroyed()) return;
        wc.executeJavaScript(
            "window.__goliveReassistirAposGateway?window.__goliveReassistirAposGateway():'nenhuma'", true,
        ).then(resultado => {
            const acao = typeof resultado === 'string' ? resultado : 'nenhuma';
            if (acao === 'aguardar' && estado.tentativa++ < REASSISTIR_TENTATIVAS - 1) {
                estado.timer = setTimeout(tentar, REASSISTIR_INTERVALO_MS);
                return;
            }
            reassistirPorWebContents.delete(wc);
            if (acao === 'clicou') log("gw.reassistir | Live visivel caiu com o gateway; clique unico enviado");
            else if (acao === 'expirada' || acao === 'tentada' || acao === 'falhou' || acao === 'cancelada_usuario') {
                log("gw.reassistir | sem nova tentativa automatica (" + acao + ")");
            }
        }).catch(() => { reassistirPorWebContents.delete(wc); });
    };
    tentar();
}

// Reconexao do gateway SEM midia recente (nem call, nem live): o motor de midia
// (WASM) pode ter ficado stale com o gateway morto — e a PROXIMA tentativa de
// transmitir que pega o "RTC connecting" eterno (issue #129: usuario no tor com
// circuito resetando a cada ~50s-4min, ws morrendo e renascendo). Recarregar a
// janela AGORA, fora de chamada, entrega um motor limpo para o proximo Go Live.
// Com midia recente NAO recarrega: encerraria a chamada da pessoa (o banner
// manual continua valendo ai). Resguardos: saida comprovadamente viva (probe) e
// no maximo 1 reload a cada 3 min, para o ws flapado nao virar loop de reload.
let ultimoAutoReloadMidia = 0;
const RELOAD_VALIDACAO_MIDIA_TIMEOUT_MS = 3_000;

// Entre a reconexao e o fim do probe da saida (ate alguns segundos), o usuario
// pode entrar numa call/Live. Reconsulta discord_voice no ultimo instante para
// que a decisao nao dependa de uma marca velha. Falha fechada: o reload e so
// uma conveniencia preventiva; interromper uma chamada real e um dano maior.
function validarMidiaAntesDoReload(win) {
    if (midiaProtegidaRecentemente(MIDIA_RECENTE_MS)) {
        return Promise.resolve({ protegida: true, motivo: "marca_recente" });
    }
    return prazoCdp(consultarRtcNativo(win), RELOAD_VALIDACAO_MIDIA_TIMEOUT_MS, "validacao de midia antes do reload")
        .then(ctx => {
            const stream = streamNativaAtiva(ctx && ctx.voice);
            if (stream !== null) {
                marcarMidiaProtegida();
                return { protegida: true, motivo: "stream_nativa_" + (stream.role || "ativa") };
            }
            if (ctx && ctx.midia && ctx.midia.midiaAberta === true) {
                marcarMidiaProtegida();
                return { protegida: true, motivo: "websocket_midia" };
            }
            // Sem um hook nativo pronto, a ausencia de stream nao e observavel.
            // Nao transformar telemetria ausente em permissao para derrubar a call.
            if (!ctx || !ctx.voice || ctx.voice.installed !== true || ctx.voice.voiceHooked !== true) {
                return { protegida: true, motivo: "estado_nativo_indisponivel" };
            }
            return {
                protegida: midiaProtegidaRecentemente(MIDIA_RECENTE_MS),
                motivo: "marca_atualizada"
            };
        })
        .catch(() => ({ protegida: true, motivo: "validacao_nativa_falhou" }));
}

function autoReloadForCleanEngine(recorrencias) {
    if (reloading) return;
    if (Date.now() - ultimoAutoReloadMidia < 3 * 60_000) return;
    const exit = chosenExit;
    if (exit === null) return;
    probe(exit, 2500).then(async ok => {
        if (ok === null) {
            log("saida " + safeProxy(exit) + " nao respondeu, adiando o reload limpo");
            return;
        }
        const win = clientWindow();
        if (win === null) return;
        const midia = await validarMidiaAntesDoReload(win);
        if (midia.protegida) {
            log("reconexao protegida: reload automatico cancelado (" + midia.motivo + ")");
            showReconnectWarning(recorrencias);
            return;
        }
        if (reloading) return;
        ultimoAutoReloadMidia = Date.now();
        log("reconexao sem midia: recarregando a janela para limpar o motor de midia (recorrencia " + recorrencias + ")");
        win.webContents.reload();
    }).catch(() => { });
}

function showReconnectWarning(recorrencias) {
    const win = clientWindow();
    if (win === null) return;

    // Um elemento so, sempre reaproveitado: se a pessoa nao fechar, a proxima reconexao
    // atualiza o texto (com a contagem) em vez de empilhar um banner por cima do outro.
    const script = "(function(){\n" +
        "  var el = document.getElementById('golivebypass-warn');\n" +
        "  if (!el) {\n" +
        "    el = document.createElement('div');\n" +
        "    el.id = 'golivebypass-warn';\n" +
        "    el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "display:flex;align-items:flex-start;gap:10px;width:320px;" +
        "background:#2b2d31;color:#f2f3f5;padding:14px 16px;border-radius:10px;" +
        "border-left:4px solid #f0b232;" +
        "font:13px/1.45 \"gg sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);" +
        "opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;'; \n" +
        "    var icon = document.createElement('div');\n" +
        "    icon.textContent = '\\u26A0\\uFE0F';\n" +
        "    icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;';\n" +
        "    var body = document.createElement('div');\n" +
        "    body.style.cssText = 'flex:1;min-width:0;';\n" +
        "    var title = document.createElement('div');\n" +
        "    title.textContent = 'GoLiveBypass';\n" +
        "    title.style.cssText = 'font-weight:600;margin-bottom:3px;color:#fff;';\n" +
        "    var text = document.createElement('div');\n" +
        "    text.id = 'golivebypass-warn-text';\n" +
        "    text.style.cssText = 'color:#d8dadf;';\n" +
        "    var restartBtn = document.createElement('button');\n" +
        "    restartBtn.type = 'button';\n" +
        "    restartBtn.textContent = 'Reiniciar agora';\n" +
        "    restartBtn.style.cssText = 'margin-top:8px;padding:5px 10px;border:0;" +
        "border-radius:6px;background:#f0b232;color:#111214;font-weight:600;font-size:12px;" +
        "cursor:pointer;';\n" +
        "    restartBtn.onmouseenter = function(){ restartBtn.style.background = '#f5c862'; };\n" +
        "    restartBtn.onmouseleave = function(){ restartBtn.style.background = '#f0b232'; };\n" +
        // location.reload() roda no CONTEXTO da pagina do Discord (nao volta para o main
        // process): equivale exatamente ao Ctrl+R que o texto do banner ja recomendava, so
        // que num clique em vez de exigir o atalho de teclado.
        "    restartBtn.onclick = function(){ location.reload(); };\n" +
        "    body.appendChild(title);\n" +
        "    body.appendChild(text);\n" +
        "    body.appendChild(restartBtn);\n" +
        "    var closeBtn = document.createElement('div');\n" +
        "    closeBtn.textContent = '\\u2715';\n" +
        "    closeBtn.style.cssText = 'cursor:pointer;color:#949ba4;font-size:14px;flex-shrink:0;padding:2px;';\n" +
        "    closeBtn.onmouseenter = function(){ closeBtn.style.color = '#f2f3f5'; };\n" +
        "    closeBtn.onmouseleave = function(){ closeBtn.style.color = '#949ba4'; };\n" +
        "    closeBtn.onclick = function(){ el.remove(); };\n" +
        "    el.appendChild(icon);\n" +
        "    el.appendChild(body);\n" +
        "    el.appendChild(closeBtn);\n" +
        "    document.body.appendChild(el);\n" +
        "    requestAnimationFrame(function(){ el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });\n" +
        "  }\n" +
        "  document.getElementById('golivebypass-warn-text').textContent = " + JSON.stringify(WARN_BANNER_TEXT) + " + " +
        "(" + recorrencias + " > 1 ? ' (aconteceu ' + " + recorrencias + " + ' vezes nesta sessao)' : '');\n" +
        "})();";

    win.webContents.executeJavaScript(script).catch(error => log("falhei ao mostrar aviso: " + error.message));
}

// Aviso INFORMATIVO (nao e alerta de erro) de que o Discord esta esperando o Tor terminar de
// subir no arranque frio -- sem isto a pessoa so ve "carregando" parado, sem saber se travou
// ou se e so demora normal (issue #116: "carregamento infinito ao abrir o aplicativo", visto
// so em modo tor, so ao ligar o PC junto com o Windows -- a GUI e um processo Electron a
// parte e o Discord nativo costuma vencer a corrida de arranque). Elemento com id proprio,
// diferente do banner de reconexao: os dois podem coexistir sem um apagar o outro.
const TOR_WAIT_BANNER_TEXT = "GoLiveBypass: aguardando o Tor terminar de iniciar para " +
    "liberar o Discord. Isso e normal logo apos ligar o PC e costuma levar menos de um " +
    "minuto -- esta janela some sozinha assim que o Tor responder.";

// Quanto insistir achando a janela do cliente antes de desistir do aviso, e de quanto em
// quanto tempo. O Discord mostra uma splash SEM url discord.com por um tempo antes do app de
// verdade (clientWindow() so acha a segunda) -- sem retry, chamar showTorBootBanner() uma vez
// so no start() perderia a janela sempre que ela ainda nao existisse, e o aviso nunca
// apareceria justamente no caso mais comum (arranque frio == Discord tambem acabou de abrir).
const TOR_BOOT_BANNER_RETRY_MS = 1500;
const TOR_BOOT_BANNER_MAX_WAIT_MS = 20_000;

function showTorBootBanner(limiteMs) {
    // coldTorHoldSince zera assim que settleExit acha uma saida (ver settleExit): se isso
    // aconteceu enquanto esperavamos a janela aparecer, o aviso perdeu a validade -- mostra-lo
    // agora só confundiria (diria "aguardando" de algo que ja foi resolvido).
    if (coldTorHoldSince === 0) return;

    const win = clientWindow();
    if (win === null) {
        const limite = limiteMs !== undefined ? limiteMs : Date.now() + TOR_BOOT_BANNER_MAX_WAIT_MS;
        if (Date.now() >= limite) return; // desiste; a janela nao apareceu a tempo
        setTimeout(() => showTorBootBanner(limite), TOR_BOOT_BANNER_RETRY_MS);
        return;
    }

    // Sem contagem/atualizacao de texto (ao contrario do banner de reconexao): este e um
    // estado de "ainda nao", nao um evento que se repete -- se o elemento ja existe, nao ha
    // nada novo para mostrar.
    const script = "(function(){\n" +
        "  var el = document.getElementById('golivebypass-tor-wait');\n" +
        "  if (el) return;\n" +
        "  el = document.createElement('div');\n" +
        "  el.id = 'golivebypass-tor-wait';\n" +
        "  el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "display:flex;align-items:flex-start;gap:10px;width:320px;" +
        "background:#2b2d31;color:#f2f3f5;padding:14px 16px;border-radius:10px;" +
        "border-left:4px solid #5865f2;" +
        "font:13px/1.45 \"gg sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);" +
        "opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;';\n" +
        "  var icon = document.createElement('div');\n" +
        "  icon.id = 'golivebypass-tor-wait-icon';\n" +
        "  icon.textContent = '\u23F3';\n" +
        "  icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;';\n" +
        "  var body = document.createElement('div');\n" +
        "  body.style.cssText = 'flex:1;min-width:0;';\n" +
        "  var title = document.createElement('div');\n" +
        "  title.textContent = 'GoLiveBypass';\n" +
        "  title.style.cssText = 'font-weight:600;margin-bottom:3px;color:#fff;';\n" +
        "  var text = document.createElement('div');\n" +
        "  text.id = 'golivebypass-tor-wait-text';\n" +
        "  text.style.cssText = 'color:#d8dadf;';\n" +
        "  text.textContent = " + JSON.stringify(TOR_WAIT_BANNER_TEXT) + ";\n" +
        "  body.appendChild(title);\n" +
        "  body.appendChild(text);\n" +
        "  el.appendChild(icon);\n" +
        "  el.appendChild(body);\n" +
        "  document.body.appendChild(el);\n" +
        "  requestAnimationFrame(function(){ el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });\n" +
        "})();";

    win.webContents.executeJavaScript(script).catch(error => log("falhei ao mostrar aviso de espera do Tor: " + error.message));
}

// Passado este prazo desde coldTorHoldSince, o Tor quase certamente ja teria terminado o
// bootstrap sozinho (ver TOR_HOLD_BUDGET_MS e o log real de bootstrap da GUI, que fecha em
// segundos) -- se o gateway ainda esta seguro aqui, o cenario mais provavel e o PROCESSO da
// GUI ter fechado ou travado (o runtime injetado no Discord nunca sobe Tor sozinho; so
// detecta). Generoso o bastante para nao confundir uma rede/maquina lenta com o processo
// morto, curto o bastante para a pessoa nao passar a sessao inteira lendo "menos de um
// minuto".
const TOR_BOOT_STALL_MS = 3 * 60_000;

const TOR_BOOT_STALL_TEXT = "GoLiveBypass: o Tor esta demorando bem mais que o normal (" +
    Math.round(TOR_BOOT_STALL_MS / 60_000) + "+ min parado). O mais provavel agora e o " +
    "aplicativo GoLiveBypass (o da bandeja) ter fechado ou travado -- ele que liga o Tor. " +
    "Feche-o e abra de novo; so reiniciar o Discord nao resolve isto.";

// Chamada do beat() a cada 30s enquanto o modo tor segue sem saida (ver beat()): esta funcao
// decide sozinha se ja passou tempo suficiente para escalar, entao o chamador nao precisa
// medir nada. So injeta o script uma vez por arranque frio (torBootStallShown).
function escalateTorBootBanner() {
    if (torBootStallShown) return;
    if (coldTorHoldSince === 0) return;
    if (Date.now() - coldTorHoldSince < TOR_BOOT_STALL_MS) return;

    const win = clientWindow();
    if (win === null) return; // sem janela ainda, o proximo beat() tenta de novo

    torBootStallShown = true;
    const script = "(function(){\n" +
        "  var el = document.getElementById('golivebypass-tor-wait');\n" +
        "  if (!el) return;\n" +
        "  el.style.borderLeftColor = '#f0b232';\n" +
        "  var icon = document.getElementById('golivebypass-tor-wait-icon');\n" +
        "  if (icon) icon.textContent = '\u26A0\uFE0F';\n" +
        "  var text = document.getElementById('golivebypass-tor-wait-text');\n" +
        "  if (text) text.textContent = " + JSON.stringify(TOR_BOOT_STALL_TEXT) + ";\n" +
        "})();";

    win.webContents.executeJavaScript(script).catch(error => log("falhei ao escalar aviso de espera do Tor: " + error.message));
}

function hideTorBootBanner() {
    const win = clientWindow();
    if (win === null) return;
    const script = "(function(){ var el = document.getElementById('golivebypass-tor-wait'); " +
        "if (el) { el.style.opacity = '0'; setTimeout(function(){ el.remove(); }, 250); } })();";
    win.webContents.executeJavaScript(script).catch(() => { });
}

// Prazo/intervalo de retentativa iguais aos do showTorBootBanner -- mesmo motivo: chooseExit()
// roda em start(), antes de a janela do CLIENTE existir (o Discord mostra uma splash sem url
// discord.com primeiro).
const MANUAL_PROXY_BANNER_RETRY_MS = 1500;
const MANUAL_PROXY_BANNER_MAX_WAIT_MS = 20_000;

const MANUAL_PROXY_BANNER_TEXT = "GoLiveBypass: a proxy que voce configurou nao respondeu " +
    "(varias vezes seguidas). Por enquanto o app esta usando uma saida automatica no lugar " +
    "dela. Reiniciar o Discord (ou dar Ctrl+R) nao resolve isso -- confira o endereco, " +
    "usuario e senha da proxy em Configuracoes.";

// So uma vez por processo (a flag e checada aqui dentro, nao no chamador): chooseExit() so
// chama isto depois do limite de falhas seguidas, mas o probe de fundo continua rodando a
// cada abertura de conexao -- sem a flag, cada falha nova tentaria mostrar/empilhar o aviso
// de novo.
function showManualProxyFailedBanner(limiteMs) {
    if (manualProxyBannerMostrado) return;

    const win = clientWindow();
    if (win === null) {
        const limite = limiteMs !== undefined ? limiteMs : Date.now() + MANUAL_PROXY_BANNER_MAX_WAIT_MS;
        if (Date.now() >= limite) return; // desiste; a janela nao apareceu a tempo
        setTimeout(() => showManualProxyFailedBanner(limite), MANUAL_PROXY_BANNER_RETRY_MS);
        return;
    }

    manualProxyBannerMostrado = true;

    const script = "(function(){\n" +
        "  var el = document.getElementById('golivebypass-manual-proxy-warn');\n" +
        "  if (el) return;\n" +
        "  el = document.createElement('div');\n" +
        "  el.id = 'golivebypass-manual-proxy-warn';\n" +
        "  el.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;" +
        "display:flex;align-items:flex-start;gap:10px;width:320px;" +
        "background:#2b2d31;color:#f2f3f5;padding:14px 16px;border-radius:10px;" +
        "border-left:4px solid #f0b232;" +
        "font:13px/1.45 \"gg sans\",-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.45);" +
        "opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease;';\n" +
        "  var icon = document.createElement('div');\n" +
        "  icon.textContent = '\u26A0\uFE0F';\n" +
        "  icon.style.cssText = 'font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;';\n" +
        "  var body = document.createElement('div');\n" +
        "  body.style.cssText = 'flex:1;min-width:0;';\n" +
        "  var title = document.createElement('div');\n" +
        "  title.textContent = 'GoLiveBypass';\n" +
        "  title.style.cssText = 'font-weight:600;margin-bottom:3px;color:#fff;';\n" +
        "  var text = document.createElement('div');\n" +
        "  text.style.cssText = 'color:#d8dadf;';\n" +
        "  text.textContent = " + JSON.stringify(MANUAL_PROXY_BANNER_TEXT) + ";\n" +
        "  body.appendChild(title);\n" +
        "  body.appendChild(text);\n" +
        "  var closeBtn = document.createElement('div');\n" +
        "  closeBtn.textContent = '\\u2715';\n" +
        "  closeBtn.style.cssText = 'cursor:pointer;color:#949ba4;font-size:14px;flex-shrink:0;padding:2px;';\n" +
        "  closeBtn.onmouseenter = function(){ closeBtn.style.color = '#f2f3f5'; };\n" +
        "  closeBtn.onmouseleave = function(){ closeBtn.style.color = '#949ba4'; };\n" +
        "  closeBtn.onclick = function(){ el.remove(); };\n" +
        "  el.appendChild(icon);\n" +
        "  el.appendChild(body);\n" +
        "  el.appendChild(closeBtn);\n" +
        "  document.body.appendChild(el);\n" +
        "  requestAnimationFrame(function(){ el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });\n" +
        "})();";

    win.webContents.executeJavaScript(script).catch(error => log("falhei ao mostrar aviso de proxy manual: " + error.message));
}

// O Tor respondeu depois de um arranque frio (issue #116): a conexao de gateway que estava
// segurada pode ja ter sido recusada (TOR_HOLD_BUDGET_MS estourado antes do Tor ficar
// pronto), e dai em diante quem decide QUANDO tentar de novo e o proprio Discord -- pode ser
// rapido, pode demorar bem mais que isto. Recarregar a janela agora forca uma tentativa
// imediata pela saida que acabou de ficar pronta, em vez de confiar no backoff dele. Guardas:
// saida comprovadamente viva (probe) e cancela se o gateway ja roteou sozinho enquanto o
// probe rodava (a conexao que estava esperando em currentExit foi entregue direto pelo
// waitingForExit, sem precisar de reload nenhum).
function maybeReloadAfterColdHold() {
    if (reloading) return;
    const exit = chosenExit;
    if (exit === null) return;

    reloading = true;
    probe(exit, 2500).then(ok => {
        if (ok === null) {
            log("saida " + safeProxy(exit) + " nao respondeu, adiando a recarga do arranque frio");
            return;
        }
        if (Date.now() - lastRoutedAt < 3000) {
            log("gateway ja roteou sozinho, recarga do arranque frio desnecessaria");
            return;
        }
        const win = clientWindow();
        if (win === null) return;
        reloadCount++;
        lastReloadAt = Date.now();
        log("Tor respondeu depois do arranque frio, recarregando atras de " + safeProxy(exit));
        win.webContents.reload();
    }).catch(error => {
        log("a checagem antes da recarga do arranque frio falhou: " + error.message);
    }).finally(() => {
        reloading = false;
    });
}

// Exposto para a bateria de testes (tests/test-exit-refresh.sh) marcar o sinal sem depender
// de uma conexao de gateway real no sandbox. Inofensivo em producao: so seta o mesmo
// timestamp que o serveSocks setaria ao abrir direto.
function _testMarkGatewayDirect() {
    gatewayWentDirectAt = Date.now();
}

// Exposto para a bateria de testes: marca o arranque frio em modo tor sem depender do
// start() inteiro (que sobe roteador local, instala PAC etc. -- pesado demais para o
// sandbox). Inofensivo em producao: so seta o mesmo timestamp que o start() setaria ao
// nao achar Tor no arranque.
function _testMarkColdTorHold(msAgo) {
    coldTorHoldSince = Date.now() - (msAgo || 0);
    torBootStallShown = false;
}

// Exposto para a bateria de testes: marca "o gateway acabou de rotear" sem depender de uma
// conexao real no sandbox. Inofensivo em producao: so seta o mesmo timestamp que
// markGatewayRouted() setaria.
function _testMarkGatewayRouted() {
    lastRoutedAt = Date.now();
}

// Uma conexao de gateway que chega antes de existir saida espera aqui, e nao para sempre:
// estourado o prazo ela sai direta -- exceto no cold start do modo "gratuitas", onde o
// fallback do Tor local (#85) entra antes do direct (ver poolFrio). Discord aberto sem
// bypass e ruim; Discord que nao abre e muito pior, e foi o pior defeito que este projeto
// ja teve.
function currentExit() {
    if (exitSettled) return Promise.resolve(chosenExit);

    return new Promise(resolve => {
        // No modo "tor" o prazo e maior: o bootstrap do Tor leva ~20s, bem mais que o orcamento
        // pensado para uma saida gratuita, e estourar o prazo aqui nao devolve conexao direta
        // (o serveSocks recusa neste modo) -- devolve so uma reconexao a toa do gateway.
        // O refresh (chamado pelo batimento quando a ativa caiu) usa probe com timeout
        // curto (3s) para nao segurar o gateway por 12+ segundos quando o Tor oscila
        // (issue #87: "loading infinito ao assistir a tela estando mto tempo com
        // discord aberto"). Espera-se o refresh terminar ate TOR_HOLD_BUDGET_MS e so
        // depois recusa-se: o refresh provavelmente ja terminou e o Tor ja voltou.
        const prazo = routeMode === "tor" ? TOR_HOLD_BUDGET_MS : HOLD_BUDGET_MS;
        const refreshRunning = routeMode === "tor" ? refreshingExit : null;

        // Se estiver no modo tor e nenhuma saida foi aprovada ainda (ex: boot do PC),
        // roda verificacao acelerada a cada 600ms para destravar o Discord sem esperar 30s
        if (routeMode === "tor" && !chosenExit) {
            const bootCheckInterval = setInterval(async () => {
                if (exitSettled) {
                    clearInterval(bootCheckInterval);
                    return;
                }
                const t = await detectTor(2500);
                if (t !== null && !exitSettled) {
                    clearInterval(bootCheckInterval);
                    settleExit(t);
                    maybeReloadAfterColdHold();
                }
            }, 600);
            setTimeout(() => clearInterval(bootCheckInterval), prazo);
        }

        const timer = setTimeout(() => {
            // Cold start no modo "gratuitas": com lista publica, as candidatas comumente
            // nao ficam prontas dentro do prazo (#98: saida escolhida so aos 20s, conexao
            // nasceu direta aos 13s). Em vez de nascer direta -- IP BR, sessao bloqueada,
            // reload a toa -- tenta o MESMO fallback do #85: o Tor local. O detectTor so
            // testa portas que ja existem (nunca sobe/para daemon); sem Tor, cai direta
            // como sempre. A preferencia por gratuitas fica intacta: se o pickFreeExit em
            // curso entregar uma saida depois, ela assume as conexoes novas sem religar
            // a sessao ativa.
            if (routeMode === "free" && poolFrio()) {
                log("gratuitas nao ficaram prontas a tempo (" + Math.round(prazo / 1000) + "s); tentando o Tor local antes de sair direta");
                detectTor(3000).then(tor => {
                    if (exitSettled) return; // uma saida gratuita chegou nesse meio-tempo
                    if (tor !== null) {
                        settleExit(tor); // entrega pra quem espera e vira a saida ativa
                        return;
                    }
                    log("sem Tor local tambem; esta conexao vai sair direta");
                    const index = waitingForExit.indexOf(deliver);
                    if (index >= 0) waitingForExit.splice(index, 1);
                    resolve(null);
                }).catch(() => {
                    if (exitSettled) return;
                    const index = waitingForExit.indexOf(deliver);
                    if (index >= 0) waitingForExit.splice(index, 1);
                    resolve(null);
                });
                return;
            }
            const index = waitingForExit.indexOf(deliver);
            if (index >= 0) waitingForExit.splice(index, 1);
            log(routeMode === "tor"
                ? "a saida nao ficou pronta a tempo; no modo tor a conexao sera recusada, nao direta"
                : "a saida nao ficou pronta a tempo, esta conexao vai sair direta");
            resolve(null);
        }, prazo);

        const deliver = proxy => {
            clearTimeout(timer);
            resolve(proxy);
        };

        waitingForExit.push(deliver);

        // Se o refresh esta rodando, espera ele terminar. O chosenExit vai ser setado
        // pelo settleExit (no refreshExit) ou ja' foi setado em outra execucao do chooseExit
        // (em outro currentExit). Quando o refresh termina, o resolve e' chamado
        // se a ativa foi setada; senao o timer estoura.
        if (refreshRunning !== null) {
            refreshRunning.then(() => {
                // O refresh terminou. Se o chosenExit foi setado (sucesso), o deliver ja'
                // foi chamado e o resolve ja' foi feito. Se nao (falha do refresh), o
                // currentExit continua esperando o timer. O tempo ate agora ja' contou
                // parte do prazo -- mas como o refresh ja' terminou, qualquer nova conexao
                // pode prosseguir com a ativa (mesmo "morta") e a recarga (se houver)
                // fara a troca.
                if (chosenExit !== null) {
                    const index = waitingForExit.indexOf(deliver);
                    if (index >= 0) waitingForExit.splice(index, 1);
                    clearTimeout(timer);
                    resolve(chosenExit);
                }
            });
        }
    });
}

// Todas as saidas conhecidas morreram no meio da sessao (acontece o tempo todo com saida
// gratuita). Em vez de cair para direto — que e o IP bloqueado, e o "carregando para sempre" —
// procura uma saida nova agora. Cooldown e dedupe: uma busca por vez, e nunca antes de 30s
// depois da ultima, senao uma saida ruim derrubaria a API de saidas num loop.
function refreshExit(manualConfirmedDead = false) {
    // Um erro isolado ao abrir o tunel nao autoriza substituir uma rota escolhida pela pessoa:
    // era este caminho que mandava a sessao manual para Tor/gratuitas e reconectava o gateway
    // no meio da Live. checkPool libera a troca somente depois dos dois batimentos completos.
    if (usingManualProxy && !manualConfirmedDead) {
        log("saida manual falhou no trafego vivo; mantendo ate morte confirmada em " + MAX_MISSED_BEATS + " batimentos");
        return Promise.resolve(null);
    }
    if (refreshingExit !== null) return refreshingExit;
    if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) return Promise.resolve(null);

    lastRefreshAt = Date.now();
    refreshingExit = (async () => {
        log("nenhuma saida do pool entregou, procurando uma saida nova");
        // Modo "tor": a reposicao tambem SO considera o Tor — cair para gratuita aqui
        // trocaria a garantia escolhida pelo usuario por um IP qualquer. Sem Tor no ar,
        // devolve null e o gateway fica segurado ate o Tor voltar.
        // Probe do Tor com timeout curto (3s) para o refresh nao segurar o gateway
        // por 12+ segundos quando o Tor esta morrendo (issue #87). O probe da escolha
        // inicial usa o timeout completo (6s) porque vale a pena esperar mais.
        // Modo "free"/"auto" tenta gratuitas; se nao houver nenhuma viva, cai pro Tor
        // (que esta rodando de qualquer jeito) em vez de devolver null e abrir direto.
        let fresh = null;
        if (routeMode === "tor") {
            fresh = await detectTor(3000);
        } else {
            fresh = await pickFreeExit();
            if (fresh === null) {
                log("gratuitas mortas, tentando Tor local como fallback");
                fresh = await detectTor();
            }
        }
        if (fresh !== null) {
            // Esta busca roda em segundo plano (sem await no chamador) e pode resolver DEPOIS
            // de uma troca sincrona ja ter acontecido no meio do caminho (a rajada de 3+
            // reconexoes do gateway chama trocarPara() sincronamente enquanto este refresh
            // ainda esta probando candidatas). Sem isto, settleExit() sozinho sobrescrevia
            // chosenExit calado: sem soltar o log estruturado de troca (fica so "saida nova
            // encontrada", sem dizer o que foi substituido) e sem limpar
            // missedBeats/rttLentoSeguidas da saida nova, que podiam carregar contagem de
            // falha de uma ativacao anterior dela.
            const antiga = chosenExit;
            if (antiga !== null && antiga !== fresh) {
                missedBeats.delete(fresh);
                rttLentoSeguidas.delete(fresh);
                gatewayReconexoes.length = 0;
                const vida = lastExitAt === 0 ? "?" : Math.round((Date.now() - lastExitAt) / 1000) + "s";
                log("saida.trocada | de=" + safeProxy(antiga) + " para=" + safeProxy(fresh) +
                    " motivo=refresh em segundo plano" +
                    " vida_da_antiga=" + vida);
            }
            settleExit(fresh);
            log("saida nova encontrada: " + safeProxy(fresh));
        } else {
            log("nenhuma saida nova disponivel agora");
        }
        return fresh;
    })();

    return refreshingExit.finally(() => { refreshingExit = null; });
}

// ------------------------------------------------------------------ manter reserva viva

// Saida gratuita nao avisa que morreu: ela para de encaminhar, e quem descobre e a conexao que
// estava passando por ela. No meio de uma transmissao isso custa a sessao inteira -- o gateway
// reconecta, e se reconectar direto o servidor reavalia a conta e o video cai. O refreshExit
// conserta isso depois que a conexao ja falhou; o batimento existe para que ela nao falhe: de
// trinta em trinta segundos a ativa e as reservas sao reconferidas, e a troca acontece antes de
// o Discord precisar.
// Quanto esperar entre tentativas de voltar pra saida manual depois que a sessao caiu dela
// (para free/pool). Uma queda na VM pode ser passageira -- medido ao vivo em 2026-08-26: uma
// saida manual ficou fora por 48min e voltou sozinha -- e sem isto o app nunca mais tentava a
// saida de confianca da pessoa, nem com ela ja saudavel de novo: so reabrir o Discord resolvia.
const MANUAL_RETRY_COOLDOWN_MS = 90_000;
let lastManualRetryAt = 0;

// So mexe fora de chamada/transmissao em andamento (ultimaMidiaEm): reconectar o gateway no
// meio de uma Live e o proprio problema que a saida manual foi blindada contra em
// trySwapByRtt. Recuperar e melhor que ficar preso em gratuita, mas nao a troco de derrubar
// uma Live que por acaso esteja de pe na saida de fallback.
//
// Modo "tor" tem politica propria (so Tor conta) -- trocar a saida ativa Tor por uma proxy
// nao-Tor configurada em settings.proxy violaria a escolha da pessoa, igual ao que
// trySwapByRtt e stockReserves ja fazem.
async function tryReturnToManual() {
    if (routeMode === "tor") return;
    if (!usingManualProxy || isManualAddress(chosenExit)) return;
    if (Date.now() - ultimaMidiaEm < MIDIA_RECENTE_MS) return;
    if (Date.now() - lastManualRetryAt < MANUAL_RETRY_COOLDOWN_MS) return;
    lastManualRetryAt = Date.now();

    const manual = manualProxy();
    if (manual === null || manual === "") return;

    const ok = await probe(manual, MANUAL_HEARTBEAT_TIMEOUT_MS);
    if (ok === null) return;

    // Troca silenciosa: NAO chama trocarPara() para nao disparar o banner amarelo de
    // "reconexao no meio da sessao" na proxima reconexao. A guarda de midia recente
    // (MIDIA_RECENTE_MS) acima ja garante que NAO estamos em Live agora, mas a proxima
    // reconexao pode acontecer minutos depois, com o timestamp de midia ja ultrapassando
    // o MIDIA_RECENTE_MS (cenario: Live terminou pouco antes do fim da janela, a troca
    // acontece logo depois dela, e o gateway reconecta logo em seguida -- banner dispara
    // sem motivo). Zera o contador para que
    // a proxima reconexao seja contada como a primeira desta "sub-sessao" (sem recorrencia
    // para o banner). Mantem o cooldown de SWAP_COOLDOWN_MS manualmente para nao abrir
    // porta para trySwapByRtt em seguida.
    ultimaTrocaProativaEm = Date.now();
    gatewayReconexoes.length = 0;
    missedBeats.delete(manual);
    rttLentoSeguidas.delete(manual);
    const antiga = chosenExit;
    const vida = antiga === null || lastExitAt === 0 ? "?" : Math.round((Date.now() - lastExitAt) / 1000) + "s";
    log("saida.trocada | de=" + (antiga === null ? "nenhuma" : safeProxy(antiga)) +
        " para=" + safeProxy(manual) +
        " motivo=saida manual voltou a responder" +
        " vida_da_antiga=" + vida);
    chosenExit = manual;
    lastExitAt = Date.now();
    gatewayConnCount = 0;
}

async function beat() {
    // Um batimento lento nunca pode se sobrepor ao proximo: seriam duas rodadas de conexoes na
    // mesma saida ao mesmo tempo, que e justamente o que derruba as fracas.
    if (beating) return;
    beating = true;

    try {
        // Modo "tor" sem saida ativa (arranque sem Tor, ou Tor morreu antes de qualquer
        // escolha): re-tenta o Tor AQUI. Sem isto ninguem mais chamaria detectTor — os
        // caminhos do batimento so rodam com uma saida ativa — e a sessao ficaria presa
        // para sempre recusando conexoes mesmo depois de o Tor voltar.
        if (routeMode === "tor" && chosenExit === null) {
            ensureTorRunning();
            const tor = await detectTor();
            if (tor !== null) {
                settleExit(tor);
                log("modo tor: Tor respondeu de novo em " + TOR_ADDR + ", religando a rota");
            } else {
                // Ainda sem Tor: se isto ja vem de um arranque frio ha tempo demais, a causa
                // provavel virou "a GUI fechou", nao "o bootstrap esta lento" -- ver
                // escalateTorBootBanner. Sem custo quando nao ha arranque frio pendente ou
                // quando o prazo ainda nao estourou (ela mesma decide e sai cedo).
                escalateTorBootBanner();
            }
            return;
        }
        await checkPool();
        await tryReturnToManual();
    } catch (error) {
        // Batimento e rede de seguranca. Se ele falhar, o caminho antigo continua valendo:
        // falhar no trafego vivo, cair para a reserva e, no fim, o refreshExit.
        log("o batimento falhou: " + error.message);
    } finally {
        beating = false;
    }
}

function ativaMortaConfirmada(active, live, dead) {
    return active !== null && !live.includes(active) && dead.includes(active);
}

async function checkPool() {
    const active = chosenExit;

    // Modo tor: a saida e UNICA e o batimento nunca a derruba. O Tor renova os
    // circuitos a cada ~10 min (MaxCircuitDirtiness) e o probe de 4s falha durante
    // a construcao do circuito novo — derrubar a saida nesse falso negativo criava
    // a janela de recusa do gateway: reconexao segurada ate um probe passar,
    // repetida a cada rotacao (log da issue #122 mostra 30 e 57 MINUTOS sem ver o
    // gateway). Agora o probe e so informativo, com timeout folgado pra construcao
    // de circuito; a reconexao tenta o tunel direto e passa quando o circuito fica
    // pronto. A morte REAL do daemon e tratada pelo listening() do detectTor no
    // refreshExit — e pelo watchdog da GUI, que ressuscita o processo.
    if (routeMode === "tor") {
        if (active === null) return; // o beat ja tenta o detectTor nesse caso
        const ok = await probe(active, HEARTBEAT_TIMEOUT_MS * 4) !== null;
        if (ok) missedBeats.delete(active);
        else log("batimento do Tor falhou (circuito construindo?); mantendo a saida");
        return;
    }

    // A ativa entra na rodada mesmo estando fora do pote: proxy do settings.json e Tor local
    // nunca sao guardados, e sao exatamente os que a pessoa mais sente quando caem.
    const targets = [];
    // Camada 3: se a ativa entregou trafego de gateway dentro da janela do batimento, ela
    // esta viva por definicao — pular o probe dela poupa uma conexao na saida gratuita, que
    // limita conexoes simultaneas. A morte real cai no openThroughPool e vira troca ali.
    if (active !== null && Date.now() - ativaEntregouEm > HEARTBEAT_MS) targets.push(active);
    for (const entry of pool) if (!targets.includes(entry.proxy)) targets.push(entry.proxy);
    if (targets.length === 0) return;

    const beats = await Promise.all(targets.map(async proxy => ({
        proxy: proxy,
        ok: await probe(proxy, isManualAddress(proxy) ? MANUAL_HEARTBEAT_TIMEOUT_MS : HEARTBEAT_TIMEOUT_MS) !== null
    })));

    const dead = [];
    for (const entry of beats) {
        if (entry.ok) {
            missedBeats.delete(entry.proxy);
            continue;
        }

        const count = (missedBeats.get(entry.proxy) || 0) + 1;
        missedBeats.set(entry.proxy, count);
        if (count >= MAX_MISSED_BEATS) dead.push(entry.proxy);
    }

    if (dead.length > 0) {
        const survivors = pool.filter(entry => !dead.includes(entry.proxy));
        if (survivors.length !== pool.length) {
            log("fora do pote: " + dead.map(safeProxy).join(", ") + " (sem resposta em " + MAX_MISSED_BEATS + " batimentos)");
            pool = survivors;
            savePool();
        }

        for (const proxy of dead) {
            missedBeats.delete(proxy);
            rttLentoSeguidas.delete(proxy);
            rttEma.delete(proxy);
        }
    }

    const live = beats.filter(entry => entry.ok).map(entry => entry.proxy);

    // A ativa que foi pulada (entregou trafego na janela) e considerada viva: ela nao passou
    // por probe, mas tem prova viva de que funciona.
    if (active !== null && !targets.includes(active) && !live.includes(active)) live.push(active);

    // Uma falha de probe e um sinal, nao uma morte: perda momentanea, circuito ocupado e
    // congestionamento da saida gratuita sao comuns. O proprio pote so aposenta a saida em
    // MAX_MISSED_BEATS batimentos, entao a ativa precisa obedecer ao mesmo limite. Trocar no
    // primeiro erro reconectava o gateway no meio da Live por um falso negativo — exatamente o
    // mecanismo que #170/#171 expuseram.
    if (active !== null && !live.includes(active)) {
        if (!ativaMortaConfirmada(active, live, dead)) {
            const misses = missedBeats.get(active) || 1;
            log(safeProxy(active) + " falhou no batimento " + misses + "/" + MAX_MISSED_BEATS + ", mantendo ate confirmar morte");
        } else {
            const reserve = live.find(proxy => proxy !== active);
            if (reserve === undefined) {
                // Nada vivo. Comeca a busca agora, em vez de esperar a proxima conexao descobrir:
                // o refreshExit ja tem dedupe e cooldown, entao chamar daqui nao duplica trabalho.
                log(safeProxy(active) + " perdeu o batimento e nao ha reserva viva");
                refreshExit(true).catch(error => log("a busca por saida nova falhou: " + error.message));
                return;
            }

            // Emergencia (a ativa morreu): troca direto, sem cooldown.
            // No modo "tor" nao existe reserva que valha a pena: o Tor e a escolha explicita e
            // trocar para gratuita violaria o pedido. Segura — o refresh continua tentando o Tor.
            if (routeMode === "tor") {
                log("modo tor: o Tor caiu, segurando o gateway (sem saida direta)");
                refreshExit().catch(error => log("a busca pelo Tor falhou: " + error.message));
                return;
            }
            trocarPara(reserve, "perdeu o batimento");
        }
    } else if (active !== null) {
        // A ativa esta viva no probe. Mesmo viva, pode estar lenta demais para o gateway
        // (RTT EMA alto): trocar antes de o websocket sofrer.
        const trocar = trySwapByRtt(active, live);
        if (trocar !== null) chosenExit = trocar;
    }

    // Sempre ordena o pool pelo RTT (EMA) ao salvar: a melhor reserva para assumir na hora
    // e a mais rapida, nao a que chegou primeiro.
    pool = [...pool].sort((a, b) => (a.proxy === chosenExit ? -1 : b.proxy === chosenExit ? 1 : (rttEma.get(a.proxy) ?? a.ms) - (rttEma.get(b.proxy) ?? b.ms)));
    savePool();

    stockReserves(live.filter(proxy => proxy !== chosenExit).length);
}

// A saida ativa passa no probe mas esta entregando mal (RTT EMA acima do teto por
// RTT_TROCA_BATIDAS batimentos seguidos). Troca para a reserva viva mais rapida antes de o
// gateway sofrer. Devolve a nova saida, ou null se nao houver troca.
function trySwapByRtt(active, live) {
    // No modo "tor" a saida e uma escolha explicita da pessoa: o RTT alto do Tor e normal
    // (1-1.4s medido) e trocar para gratuita violaria a escolha. Soh troca se o Tor morrer.
    if (routeMode === "tor") return null;

    // Saida manual/privada: as "reservas" no range multiplexado sao portas do MESMO servidor,
    // com RTT praticamente identico -- entao SWAP_RESERVA_RAZAO quase sempre deixa passar, e
    // qualquer chacoalhada de rede vira troca. Toda troca reconecta o gateway, e o motor de
    // voz/video do Discord (WASM) nao sobrevive a isso com a Live no ar: o video cai pra
    // sempre (so audio) mesmo trocando para uma saida boa. Nao vale o risco por causa de RTT.
    if (usingManualProxy) return null;

    // A mesma protecao vale para gratuitas: RTT alto e um sinal de qualidade, nao de morte.
    // Trocar enquanto a midia esta aberta pode disparar a corrida de renegociacao do
    // viewer/sender (a ocorrencia de 01/09 fechou o RTC 11s depois de uma troca por RTT).
    // A saida continua sendo monitorada; se morrer de verdade, checkPool troca por
    // emergencia sem passar por este bloqueio.
    if (midiaRecenteParaTrocaProativa()) {
        rttLentoSeguidas.delete(active);
        log(safeProxy(active) + " com RTT alto, troca proativa suspensa: midia recente");
        return null;
    }

    const ema = rttEma.get(active);
    if (ema === undefined || ema < RTT_TROCA_MS) {
        rttLentoSeguidas.delete(active);
        return null;
    }

    const ruins = (rttLentoSeguidas.get(active) || 0) + 1;
    rttLentoSeguidas.set(active, ruins);
    if (ruins < RTT_TROCA_BATIDAS) {
        log(safeProxy(active) + " com RTT alto (" + Math.round(ema) + "ms), " + ruins + "/" + RTT_TROCA_BATIDAS + " batimentos");
        return null;
    }

    // Cooldown: quando o pool inteiro esta lento, esperar o cooldown antes de trocar de
    // novo evita o ping-pong entre ruins (cada troca renasce o gateway a toa).
    if (!trocaProativaPode()) {
        rttLentoSeguidas.delete(active);
        return null;
    }

    // Pelo menos 1 batimento de folga antes de trocar de novo pela mesma causa: evita
    // cascata quando a reserva tambem esta lenta.
    const alvo = live
        .filter(proxy => proxy !== active)
        .sort((a, b) => (rttEma.get(a) ?? Infinity) - (rttEma.get(b) ?? Infinity))[0];
    if (alvo === undefined) {
        log(safeProxy(active) + " lento mas sem reserva viva para trocar");
        rttLentoSeguidas.delete(active);
        return null;
    }

    // So vale trocar para uma reserva que nao seja visivelmente pior: a atual ja esta ruim,
    // mas piorar (ou trocar pelo mesmo nivel) so renasce o gateway a toa.
    const emaAlvo = rttEma.get(alvo) ?? Infinity;
    if (emaAlvo > ema * SWAP_RESERVA_RAZAO) {
        log(safeProxy(active) + " lento (" + Math.round(ema) + "ms EMA) e reserva pior (" + Math.round(emaAlvo) + "ms), mantendo e buscando reserva melhor");
        rttLentoSeguidas.delete(active);
        return null;
    }

    trocarPara(alvo, "ativa lenta " + Math.round(ema) + "ms EMA");
    rttLentoSeguidas.delete(active);
    return alvo;
}

// Repor reserva nao pode passar pelo refreshExit: aquele caminho troca a saida ativa, e trocar
// de IP com a ativa saudavel pediria uma reavaliacao do servidor a toa. Aqui o pote enche por
// baixo e quem esta entregando continua entregando.
function stockReserves(liveReserves) {
    // No modo "tor" nao existe reserva legitima: encher o pote com gratuitas violava a
    // escolha da pessoa e um dia essas gratuitas venciam o fallback do openThroughPool,
    // trocando a sessao pra fora do Tor sem ninguem pedir (visto ao vivo em 2026-08-23).
    if (routeMode === "tor") return;

    // Saida manual/privada (com ou sem range): nao ha ganho em manter reserva quente. O pote
    // so serve para a troca proativa por RTT (desligada para manual, ver trySwapByRtt) e para
    // o fallback de trafego morto no openThroughPool -- que ja tem seu proprio caminho via
    // refreshExit/huntExits quando a ativa falha de verdade. Manter isto vazio evita testar o
    // range inteiro (ate 51 portas em paralelo) a cada poucos minutos so para guardar reserva
    // que nunca vai ser usada.
    if (usingManualProxy || routeMode === "tor") return;
    if (liveReserves >= MIN_LIVE_RESERVES || stocking !== null) return;

    // Relogio proprio, separado do refreshExit de proposito. Compartilhar os dois fazia a
    // reposicao de rotina adiar a busca de emergencia: o pote esvazia justamente quando as
    // saidas estao morrendo, que e quando a ativa tambem morre, entao a conexao de gateway que
    // pedisse socorro nessa janela sairia direta. Era a falha que este batimento existe para
    // impedir.
    if (Date.now() - lastStockAt < STOCK_COOLDOWN_MS) return;

    lastStockAt = Date.now();
    log("o pote esta com " + liveReserves + " reserva(s) viva(s), procurando mais em segundo plano");

    stocking = huntExits().then(aprovadas => {
        const known = pool.map(entry => entry.proxy);
        const fresh = aprovadas.filter(entry => !known.includes(entry.proxy));
        if (fresh.length === 0) return;

        // A ativa fica no pote mesmo sendo mais lenta que as novas: ela e o IP que o servidor ja
        // aceitou nesta sessao, e trocar por velocidade custaria uma reavaliacao.
        pool = [...pool, ...fresh]
            .sort((a, b) => (a.proxy === chosenExit ? -1 : b.proxy === chosenExit ? 1 : a.ms - b.ms))
            .slice(0, POOL_SIZE);

        savePool();
        log(fresh.length + " reserva(s) nova(s) no pote");
    }).catch(error => log("a busca de reserva falhou: " + error.message))
        .finally(() => { stocking = null; lastStockAt = Date.now(); });
}

// ------------------------------------------------------------------ o roteador local

function refuse(client) {
    if (!client.destroyed) client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function readTarget(client, done) {
    readReply(client, buffer => {
        if (buffer.length < 5) return -1;
        if (buffer[3] === 1) return 10;
        if (buffer[3] === 4) return 22;
        if (buffer[3] === 3) return 7 + buffer[4];
        return -1;
    }, message => {
        if (message === null || message[1] !== 1) return done(null);

        if (message[3] === 3) {
            const length = message[4];
            return done({ host: message.subarray(5, 5 + length).toString("utf8"), port: message.readUInt16BE(5 + length) });
        }
        if (message[3] === 1) return done({ host: Array.from(message.subarray(4, 8)).join("."), port: message.readUInt16BE(8) });

        return done(null);
    });
}

function openDirect(target) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            if (value === null) direct.destroy();
            else direct.setTimeout(0);
            resolve(value);
        };

        const direct = connect({ host: target.host, port: target.port });
        direct.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
        direct.on("error", () => finish(null));
        direct.once("connect", () => finish(direct));
    });
}

// Abre o mesmo destino por varias saidas ao mesmo tempo e fica com a primeira que responder.
// Quem chega depois e fechado na hora: tunel aberto e esquecido segura uma conexao do outro
// lado, e saida gratuita costuma ter poucas.
function firstTunnel(candidates, target, timeoutMs) {
    return new Promise(resolve => {
        let pending = candidates.length;
        if (pending === 0) return resolve(null);

        let settled = false;

        for (const candidate of candidates) {
            openTunnel(candidate, target.host, target.port, timeoutMs).then(socket => {
                if (socket !== null && !settled) {
                    settled = true;
                    return resolve({ proxy: candidate, socket: socket });
                }

                if (socket !== null) socket.destroy();
                if (--pending === 0 && !settled) resolve(null);
            });
        }
    });
}

// Tenta a saida ativa e, se ela nao entregar, as reservas ja testadas. Trocar aqui custa uma
// conexao; esperar a proxima abertura do Discord custa a sessao inteira sem bypass.
async function openThroughPool(target) {
    const active = await currentExit();
    if (active === null) return null;

    // A ativa sozinha primeiro: ela e o IP que o servidor ja viu nesta sessao, e trocar sem
    // precisar seria pedir uma reavaliacao a toa. No modo tor o prazo e o folgado
    // (TOR_RELAY_TIMEOUT_MS): construcao de circuito do Tor nao pode ser abortada.
    const tAtiva = Date.now();
    const prazoTunel = routeMode === "tor"
        ? TOR_RELAY_TIMEOUT_MS
        : isManualAddress(active) ? MANUAL_HEARTBEAT_TIMEOUT_MS : RELAY_TIMEOUT_MS;
    const direto = await openTunnel(active, target.host, target.port, prazoTunel);
    if (direto !== null) {
        markGatewayRouted();
        log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(active) + " via=ativa latencia=" + (Date.now() - tAtiva) + "ms");
        return direto;
    }

    log(safeProxy(active) + " nao entregou " + target.host);

    // A abertura falha uma vez antes de um proxy lento recuperar com facilidade. Nao deixa
    // esta unica tentativa trocar a saida manual nem abrir DIRECT; o batimento decide a morte
    // confirmada e so entao checkPool chama refreshExit(true).
    if (isManualAddress(active)) {
        log("saida manual preservada apos falha unica; aguardando " + MAX_MISSED_BEATS + " batimentos antes de trocar");
        return null;
    }

    // As reservas correm todas juntas em vez de uma por vez: enfileiradas, o prazo de cada uma
    // somava com o gateway ja reconectando, e o Chromium desiste do roteador antes disso.
    const won = await firstTunnel(pool.map(entry => entry.proxy).filter(proxy => proxy !== active), target, RELAY_TIMEOUT_MS);
    if (won !== null) {
        log("a saida " + safeProxy(active) + " parou de entregar, troquei para " + safeProxy(won.proxy));
        chosenExit = won.proxy;
        lastExitAt = Date.now();
        missedBeats.delete(active);
        pool = pool.filter(entry => entry.proxy !== active);
        savePool();
        markGatewayRouted();
        log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(won.proxy) + " via=reserva latencia=" + (Date.now() - tAtiva) + "ms");
        return won.socket;
    }

    // Pool inteiro morto: antes de render a conexao ao IP brasileiro (o "carregando para
    // sempre"), tenta o cache do state.json (revalidacao rapida, ~1-2s) e so entao a lista
    // nova (lenta, ~4s+). No caso do ciclo 7 o pool tinha 1 saida que morreu; o cache teria
    // saidas guardadas de aberturas anteriores para assumir na hora.
    const cached = await cachedExit();
    if (cached !== null) {
        const socket = await openTunnel(cached, target.host, target.port, PROBE_TIMEOUT_MS);
        if (socket !== null) {
            chosenExit = cached;
            lastExitAt = Date.now();
            markGatewayRouted();
            log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(cached) + " via=cache latencia=" + (Date.now() - tAtiva) + "ms");
            return socket;
        }
        log(safeProxy(cached) + " do cache nao entregou " + target.host);
    }

    const fresh = await refreshExit();
    if (fresh !== null) {
        const socket = await openTunnel(fresh, target.host, target.port, PROBE_TIMEOUT_MS);
        if (socket !== null) {
            chosenExit = fresh;
            lastExitAt = Date.now();
            markGatewayRouted();
            log("tunel.aberto | alvo=" + target.host + " saida=" + safeProxy(fresh) + " via=nova latencia=" + (Date.now() - tAtiva) + "ms");
            return socket;
        }
        log(safeProxy(fresh) + " nao entregou " + target.host + " logo depois de escolhida");
    }

    return null;
}

// O PAC roteia por sufixo de dominio de proposito: o Discord conecta o gateway em
// subdominios regionais (gateway-us-east1-b.discord.gg — o "-us-east1-b" vem ANTES de
// discord.gg), e o match exato deixava essas conexoes fora do roteador: o gateway nascia
// direto pelo IP brasileiro e o servidor bloqueava a sessao (o "carregando infinitamente").
// Roteamos *.discord.gg inteiro (gateway, remote-auth-gateway e qualquer subdominio futuro);
// os CDNs de midia sao discordapp.com, outro dominio, e nao passam por aqui.
const ROUTE_SUFFIX = ".discord.gg";

function isRoutedHost(host) {
    return host === "discord.gg" || host.endsWith(ROUTE_SUFFIX);
}

function serveSocks(client) {
    client.on("error", () => client.destroy());
    // Entrada malformada deixaria o socket pendurado para sempre, porque a negociacao nunca
    // completa e ninguem fecha. O prazo cobre isso.
    client.setTimeout(PROBE_TIMEOUT_MS, () => client.destroy());

    readReply(client, buffer => (buffer.length < 2 ? -1 : 2 + buffer[1]), greeting => {
        if (greeting === null || greeting[0] !== 5) return client.destroy();

        client.write(Buffer.from([5, 0]));
        readTarget(client, async target => {
            if (target === null) return refuse(client);

            // O roteador so aceita os hosts que o PAC manda para ele. Sem esta linha ele seria
            // um SOCKS aberto no loopback: qualquer processo da maquina usaria a sua saida para
            // qualquer destino, com a identidade do Discord no firewall.
            if (!isRoutedHost(target.host)) {
                log("recusando destino fora da lista: " + target.host);
                return refuse(client);
            }

            // Sucesso respondido antes de saber a saida, de proposito: o Chromium para de usar
            // um roteador que responda lento, e segurar a resposta aqui deixava o Discord
            // "carregando" por ate 12s (o prazo da escolha da saida). Se a saida falhar, o
            // socket fecha no meio do handshake e o cliente do gateway reconecta com backoff.
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.setTimeout(0);

            let upstream = await openThroughPool(target);

            if (upstream === null) {
                // No modo "tor" a promessa e outra: sem Tor nenhuma sessao presta (o gateway
                // nasceria pelo IP brasileiro e o video nunca viria). Recusar a conexao faz
                // o cliente do gateway re-tentar com backoff; o batimento religa a rota assim
                // que um Tor responder. Nao marca gatewayWentDirectAt: recusa nao e vazo.
                if (routeMode === "tor") {
                    log("modo tor: nenhuma saida entregou " + target.host + ", recusando esta conexao (sem vazo direta)");
                    client.destroy();
                    return;
                }
                // Recusar aqui prendia o Discord em "conectando" para sempre: o PAC nao tem
                // alternativa depois do ponto e virgula, entao uma recusa nao vira conexao
                // direta, vira nada. Sair direto custa o bypass desta conexao; recusar custa o
                // Discord inteiro, e saida gratuita morre no meio da sessao o tempo todo.
                log("nenhuma saida entregou " + target.host + ", esta conexao vai sair direta");
                // Sinal para o watchdog de recarga: o roteador abriu direto para um host de
                // gateway — a sessao nasceu (ou vai nascer) pelo IP brasileiro, e o servidor
                // provavelmente bloqueou. So o roteador sabe disto; e o gatilho confiavel.
                gatewayWentDirectAt = Date.now();
                sessaoDiretas++;
                log("saida.direta | alvo=" + target.host +
                    " saida_atual=" + (chosenExit === null ? "nenhuma" : safeProxy(chosenExit)));
                const tDireto = Date.now();
                upstream = await openDirect(target);
                // A saida pode ter estado de pe e falhado so nesta conexao (congestionamento,
                // giro de IP): com saida viva, a recarga repara a sessao na hora, em vez de
                // esperar o Ctrl+R da pessoa. Sem saida, o settleExit futuro chama isto.
                if (upstream !== null) {
                    log("direto.aberto | alvo=" + target.host + " levou=" + (Date.now() - tDireto) + "ms");
                    maybeReloadAfterDirect();
                } else {
                    log("direto: " + target.host + " falhou (sem rota local?)");
                }
            }

            if (upstream === null) return client.destroy();
            if (client.destroyed) return upstream.destroy();

            const saidaInfo = typeof chosenExit === "string" && chosenExit ? safeProxy(chosenExit) : "direta";
            const tTunel = Date.now();
            upstream.on("error", e => log("[net] tunel.caiu | alvo=" + target.host +
                " saida=" + saidaInfo +
                " errno=" + (e && e.code ? e.code : "desconhecido") +
                " vida=" + Math.round((Date.now() - tTunel) / 1000) + "s"));
            client.on("error", e => log("[net] cliente.falha | alvo=" + target.host + " errno=" + (e && e.code ? e.code : "desconhecido")));
            client.on("close", () => upstream.destroy());
            upstream.on("close", () => client.destroy());
            upstream.pipe(client);
            client.pipe(upstream);
        });
    });
}

function startRouter() {
    return new Promise(resolve => {
        const server = createServer(serveSocks);
        server.on("error", error => {
            log("o roteador local nao subiu: " + error.message);
            resolve(false);
        });
        // Loopback e porta escolhida pelo sistema: nao ha colisao possivel, e nada de fora da
        // maquina alcanca isto.
        server.listen(0, "127.0.0.1", () => {
            socksPort = server.address().port;
            log("roteador local escutando em 127.0.0.1:" + socksPort);
            resolve(true);
        });
    });
}

function pacScript(fallback) {
    // Sem alternativa depois do ponto e virgula de proposito. Com uma, uma falha faria o
    // Chromium marcar o roteador como ruim e mandar tudo pela alternativa sem avisar: PAC
    // servido, roteador de pe, e nenhuma conexao passando. A rede de seguranca fica dentro do
    // roteador, que cai para direto sozinho e registra isso.
    //
    // Casamento por sufixo de dominio (ver isRoutedHost): o gateway real conecta em
    // subdominios regionais (gateway-us-east1-b.discord.gg). endsWith("." + dominio) e nao
    // indexOf: aquele casaria discord.gg.evil.com.
    return "var routed = " + JSON.stringify(ROUTE_SUFFIX) + ";\n"
        + "function FindProxyForURL(url, host) {\n"
        + "    if (host === \"discord.gg\" || host.endsWith(routed)) return \"SOCKS5 127.0.0.1:" + socksPort + "\";\n"
        + "    return " + JSON.stringify(fallback) + ";\n"
        + "}\n";
}

async function installPac() {
    let fallback = "DIRECT";
    try {
        // Quem esta atras de proxy corporativo perderia o Discord se a regra virasse DIRECT na
        // marra, entao a regra do sistema e lida antes e devolvida a todo host nao roteado.
        const resolved = await session.defaultSession.resolveProxy("https://" + DISCORD_HOST);
        if (typeof resolved === "string" && resolved.trim() !== "") fallback = resolved.trim();
    } catch (error) {
        log("nao consegui ler a regra do sistema, usando DIRECT: " + error.message);
    }

    try {
        await session.defaultSession.setProxy({ mode: "pac_script", pacScript: "data:application/x-ns-proxy-autoconfig;base64," + Buffer.from(pacScript(fallback), "utf8").toString("base64") });
    } catch (error) {
        log("o Chromium recusou a regra: " + error.message);
        return false;
    }

    // Conferir em vez de supor: se a regra nao pegou, e melhor saber agora do que descobrir
    // pelo usuario dizendo que nao funciona. O canônico e um subdominio regional de exemplo:
    // o gateway real conecta em subdominios, e um PAC que so roteia o canônico passaria no
    // teste antigo mesmo estando quebrado para o que importa.
    try {
        const checks = [
            "https://" + ROUTED_HOSTS[0],
            "https://gateway-us-east1-b.discord.gg"
        ];
        const results = await Promise.all(checks.map(url => session.defaultSession.resolveProxy(url)));
        const ok = results.every(r => String(r).includes(String(socksPort)));
        if (!ok) {
            log("a regra foi aceita mas nao esta valendo (" + results.join(", ") + "), voltando para o sistema");
            await session.defaultSession.setProxy({ mode: "system" });
            return false;
        }
        log("regra no ar: *" + ROUTE_SUFFIX + " pelo roteador, o resto por " + fallback);

        // Fecha as conexoes existentes: o Discord reaberto rapido REUSA o websocket antigo
        // (fast connect), que nasceu direto antes do PAC e continuaria direto — o bypass
        // ficaria inerte (o teste de estresse pegou isto: "gateway visto" sem "roteado").
        // Sem fechar, a sessao bloqueada de antes continua valendo apos reabrir.
        try {
            await session.defaultSession.closeAllConnections();
            log("conexoes antigas fechadas, o gateway vai renascer pela rota");
        } catch (error) {
            log("nao consegui fechar as conexoes antigas: " + error.message);
        }
    } catch (error) {
        log("nao consegui conferir a regra: " + error.message);
    }

    return true;
}

// ------------------------------------------------------------------ sobreviver a atualizacao

const STUB_PACKAGE = JSON.stringify({ name: "discord", main: "index.js", version: "1.0.0" });

function patchResources(resources, patcherPath) {
    const asar = join(resources, "app.asar");
    const original = join(resources, "_app.asar");
    if (fs.existsSync(original) || !fs.existsSync(asar)) return false;

    try {
        if (fs.lstatSync(asar).isDirectory()) return false;
        fs.renameSync(asar, original);
        fs.mkdirSync(asar);
        fs.writeFileSync(join(asar, "package.json"), STUB_PACKAGE);
        fs.writeFileSync(join(asar, "index.js"), "require(" + JSON.stringify(patcherPath) + ");");
        return true;
    } catch (error) {
        log("nao consegui aplicar em " + resources + ": " + error.message);
        return false;
    }
}

// O Discord se atualiza numa pasta app-VERSAO nova, sem a nossa injecao, e o bypass sumiria em
// silencio na proxima abertura. Como esta versao ainda esta rodando quando a nova aparece, da
// para deixar ela pronta aqui.
function patchNewerSiblings(currentResources) {
    if (process.platform !== "win32") return;

    const currentDir = dirname(currentResources);
    const root = dirname(currentDir);
    const current = basename(currentDir);

    let names;
    try {
        names = fs.readdirSync(root);
    } catch {
        return;
    }

    for (const name of names) {
        if (!name.startsWith("app-") || name === current) continue;
        if (name.localeCompare(current, undefined, { numeric: true }) <= 0) continue;

        const resources = join(root, name, "resources");
        if (!fs.existsSync(resources)) continue;
        if (patchResources(resources, join(HERE, basename(__filename)))) log("versao nova encontrada, ja deixei pronta: " + name);
    }
}

// ------------------------------------------------------------------ entrada

// Este arquivo e carregado pelo index.js do stub, mas fica fora do app.asar no Linux.
// Nao usar process.argv[1] cegamente: ao iniciar o Discord com uma flag (por exemplo
// --remote-debugging-port=9222 ou --url), argv[1] e a flag, nao o caminho do app. Isso
// fazia o runtime procurar ../_app.asar relativo a ~/.local/share/GoLiveBypass e matar o
// processo antes de abrir a janela — o laboratorio E2E descobriu a regressao em beta.13.
function caminhoAppStub(value) {
    if (typeof value !== "string" || value === "" || value.startsWith("-")) return null;

    let resolvido;
    try {
        resolvido = resolve(value);
        if (!fs.existsSync(resolvido)) return null;
        const info = fs.statSync(resolvido);
        if (info.isDirectory()) {
            if (basename(resolvido) === "app.asar") return resolvido;
            if (basename(resolvido) === "resources" && fs.existsSync(join(resolvido, "app.asar"))) {
                return join(resolvido, "app.asar");
            }
            return null;
        }
        if (basename(resolvido) === "index.js" && basename(dirname(resolvido)) === "app.asar") {
            return dirname(resolvido);
        }
    } catch {
        return null;
    }
    return null;
}

function acharAppStub() {
    const candidatos = [];
    // Quando o script esta dentro do proprio resources (e tambem no sandbox dos testes),
    // este e o caminho mais simples. O runtime externo do Linux continua usando os sinais
    // do chamador abaixo.
    const appLocal = join(HERE, "app.asar");
    if (fs.existsSync(join(HERE, "_app.asar"))) return appLocal;

    // Quando este modulo e required pelo stub, module.parent e o sinal mais direto e nao
    // depende de como o Electron montou require.main.
    if (module.parent && module.parent.filename) candidatos.push(module.parent.filename);
    if (require.main && require.main.filename) candidatos.push(require.main.filename);
    // Clientes paralelos podem colocar o app no argv; flags e caminhos inexistentes sao
    // descartados pelo helper. Tambem aceitamos o argumento --app-path=/... usado por
    // alguns wrappers Electron.
    for (const argumento of process.argv.slice(1)) {
        candidatos.push(argumento);
        if (argumento.startsWith("--app-path=")) candidatos.push(argumento.slice("--app-path=".length));
    }

    for (const candidato of candidatos) {
        const app = caminhoAppStub(candidato);
        if (app && fs.existsSync(join(dirname(app), "_app.asar"))) return app;
    }
    return null;
}

const injectorPath = acharAppStub();
if (!injectorPath) {
    throw new Error("nao achei o app.asar injetado no chamador do GoLiveBypass");
}
const resourcesDir = dirname(injectorPath);
const asarPath = join(resourcesDir, "_app.asar");

async function start() {
    log("--- abrindo ---");

    if (settings.enabled === false) {
        log("desligado em settings.json, nao vou mexer em nada");
        return;
    }

    // A regra do PAC nao carrega usuario e senha: ela so diz o endereco. Quando a saida pede
    // autenticacao, quem responde e o Chromium, por este evento. Sem isto a saida com senha
    // passaria no nosso teste, que negocia na mao, e falharia no uso de verdade.
    app.on("login", (event, _webContents, _request, authInfo, callback) => {
        // Sem esta checagem responderiamos a qualquer site que pedisse senha, entregando a
        // credencial da saida para quem nao tem nada a ver com ela.
        if (!authInfo.isProxy || chosenExit === null) return;

        const parsed = parseProxy(chosenExit);
        if (parsed === null || parsed.user === "") return;
        if (authInfo.host !== parsed.host || authInfo.port !== parsed.port) return;

        event.preventDefault();
        callback(parsed.user, parsed.pass);
    });

    if (!await startRouter()) return;
    if (!await installPac()) return;

    // Observa os handshakes websocket do cliente: o gateway real conecta em subdominios
    // regionais (gateway-us-east1-b.discord.gg). O registro mostra se o gateway nasceu com
    // ou sem saida na mao — o diagnostico da corrida. A marcacao de "nasceu direto" fica no
    // serveSocks, no momento em que a conexao realmente sai direta; marcar aqui era cedo
    // demais, porque a conexao de gateway espera a saida no currentExit (ate 12s) e passa
    // roteada quando ela chega. O falso positivo ativava o fluxo de recarga em toda abertura
    // e o cancelava em seguida ("recarga desnecessaria"), deixando o mecanismo sem efeito
    // justamente nos casos em que a sessao tinha nascido direta de verdade.
    //
    // Este observador tambem e o medidor de sofrimento da saida: cada handshake NOVO do
    // gateway (reconexao) e contado numa janela. Rajada de reconexoes = a saida nao esta
    // aguentando o trafego vivo, mesmo passando no probe. Acima do limite, troca forcada
    // para a reserva mais rapida — o sinal mais confiavel que temos.
    // O callback e obrigatorio (sem ele a request pendura para sempre); nao modificamos nada.
    try {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            // Os websockets de voz/video moram em *.discord.media e nao passam pela saida (so
            // o gateway passa). Servem aqui como sinal de que existe chamada ou transmissao
            // em andamento -- e so nesse caso uma reconexao de gateway tem o que estragar.
            if (details.resourceType === "webSocket") {
                try {
                    if (new URL(details.url).hostname.endsWith(".discord.media")) {
                        marcarMidiaProtegida();
                    }
                } catch {
                    // url estranha; ignora
                }
            }

            if (details.resourceType === "webSocket" && isRoutedHost(new URL(details.url).hostname)) {
                // NUNCA logar a URL: a query do handshake autenticado carrega o token
                // do Discord. So o hostname + contagem da janela — o suficiente para
                // diagnosticar reconexoes sem vazar credencial.
                const agora = Date.now();
                const host = new URL(details.url).hostname;
                const saidaInfo = chosenExit === null
                    ? "sem saida ainda"
                    : "saida pronta ha " + Math.round((Date.now() - lastExitAt) / 1000) + "s";
                const ultimoVistoHa = ultimoVistoAt === 0 ? "?" : (agora - ultimoVistoAt) + "ms";
                ultimoVistoAt = agora;
                log("gw.visto | host=" + host +
                    " n_janela=" + gatewayReconexoes.length + "/180s" +
                    " n_sessao=" + (gatewayConnCount + 1) +
                    " ultimo_visto_ha=" + ultimoVistoHa +
                    " | " + saidaInfo);

                // Reconexao em rajada (ignora a primeira conexao da sessao, que nao e sinal).
                // A reconexao provocada pelo NOSSO revive tambem nao conta: alimentaria a
                // rajada e quarentenaria a saida sadia por uma acao nossa (o close 4000 do
                // revive SEMPRE causa uma reconexao — e o previsto).
                if (revivePendenteEm > 0 && agora - revivePendenteEm < GW_REVIVE_TTL_MS) {
                    log("gw.revive | reconexao do revive: fora da janela de rajada");
                } else if (chosenExit !== null) {
                    gatewayReconexoes.push(agora);
                    while (gatewayReconexoes.length > 0 && gatewayReconexoes[0] < agora - RECONEXAO_JANELA_MS) gatewayReconexoes.shift();

                    // Segunda reconexao na janela: ja e sinal de saida agonizante. Dispara o
                    // refresh em segundo plano — quando a rajada fechar (3+), ha candidato
                    // novo para trocar em vez de so a sauda velha do pool.
                    if (gatewayReconexoes.length === RECONEXAO_LIMITE - 1 && routeMode !== "tor") {
                        log("gw.rajada_antecipada | n=" + gatewayReconexoes.length + "/180s");
                        refreshExit().catch(error => log("a busca antecipada falhou: " + error.message));
                    }

                    if (gatewayReconexoes.length >= RECONEXAO_LIMITE) {
                        // Intervalos entre as reconexoes da rajada (para o log).
                        const deltas = [];
                        for (let i = 1; i < gatewayReconexoes.length; i++) deltas.push(gatewayReconexoes[i] - gatewayReconexoes[i - 1]);
                        const minD = deltas.length ? Math.min(...deltas) : 0;
                        const medD = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;

                        // No modo Tor a rajada e informativa: so existe uma saida e
                        // detectTor/watchdog ja cuidam da morte real do daemon. Fazer
                        // refresh e quarentena aqui apenas acrescentava probes durante
                        // o bootstrap do circuito e registrava falsamente que o Tor
                        // unico deveria ser evitado. Preserva a saida e abre uma janela
                        // nova de diagnostico sem trocar nem bloquear nada.
                        if (routeMode === "tor") {
                            log("gw.rajada_tor | n=" + gatewayReconexoes.length + "/180s" +
                                " intervalo_min=" + minD + "ms intervalo_med=" + medD + "ms" +
                                " informativa: saida unica preservada, sem refresh/quarentena");
                            gatewayReconexoes.length = 0;
                            callback({});
                            return;
                        }

                        const emaAtual = rttEma.get(chosenExit) ?? Infinity;
                        // Cooldown + reserva que preste: trocar entre saidas ruins em cascata
                        // so renasce o gateway a toa; sem reserva melhor, a atual vai para a
                        // quarentena e a busca em 2o plano escolhe outra.
                        const alvo = pool
                            .map(entry => entry.proxy)
                            .filter(proxy => proxy !== chosenExit)
                            .sort((a, b) => (rttEma.get(a) ?? Infinity) - (rttEma.get(b) ?? Infinity))[0];
                        const emaAlvo = alvo === undefined ? Infinity : (rttEma.get(alvo) ?? Infinity);
                        const midiaProtegida = midiaRecenteParaTrocaProativa();
                        const cooldownOk = trocaProativaPode();
                        const podeTrocar = alvo !== undefined && !midiaProtegida && cooldownOk &&
                            emaAlvo <= emaAtual * SWAP_RESERVA_RAZAO;
                        log("gw.rajada_limite | n=" + gatewayReconexoes.length + "/180s" +
                            " intervalo_min=" + minD + "ms intervalo_med=" + medD + "ms" +
                            " ema_atual=" + (emaAtual === Infinity ? "?" : Math.round(emaAtual) + "ms") +
                            " ema_alvo=" + (emaAlvo === Infinity ? "?" : Math.round(emaAlvo) + "ms") +
                            " troca=" + (podeTrocar ? "sim" : "nao") +
                            " motivo=" + (alvo === undefined ? "sem_reserva" : midiaProtegida ? "midia_recente" : !cooldownOk ? "cooldown" : "reserva_pior"));
                        if (podeTrocar) {
                            const antiga = chosenExit;
                            trocarPara(alvo, RECONEXAO_LIMITE + "+ reconexoes do gateway na janela");
                            quarentenar(antiga, "rajada de reconexoes");
                        } else {
                            gatewayReconexoes.length = 0;
                            if (!midiaProtegida) {
                                quarentenar(chosenExit, RECONEXAO_LIMITE + "+ reconexoes sem troca util");
                                log(safeProxy(chosenExit) + " com " + RECONEXAO_LIMITE + "+ reconexoes do gateway sem troca util (cooldown ou reserva pior), em quarentena");
                            } else {
                                log(safeProxy(chosenExit) + " preservada: rajada durante midia recente, sem troca/quarentena proativa");
                            }
                        }
                    }
                }
            }
            callback({});
        });
    } catch (error) {
        log("nao consegui observar os websockets: " + error.message);
    }

    const exit = await chooseExit();
    if (exit === null && routeMode === "tor") {
        // Modo "tor": sem Tor no arranque NAO libera as conexoes pendentes para o direct.
        // Elas ficam seguradas ate o prazo delas; o batimento continua e quando um Tor
        // responder settleExit(tor) religa a rota. Vazar direto aqui renasceria o gateway
        // pelo IP brasileiro — exatamente o carregamento infinito que o projeto combate.
        log("modo tor: sem Tor no arranque, conexoes ficam seguradas ate um Tor responder");
        coldTorHoldSince = Date.now();
        showTorBootBanner();
    } else {
        settleExit(exit);
        log(exit === null ? "nenhuma saida respondeu, o gateway vai sair direto" : "saida escolhida: " + safeProxy(exit));
    }

    // So depois da primeira escolha: batimento correndo junto da busca inicial disputaria banda
    // com ela, e e a busca inicial que segura o gateway.
    setInterval(() => { beat(); }, HEARTBEAT_MS);
    log("batimento ligado: reconfiro as saidas a cada " + Math.round(HEARTBEAT_MS / 1000) + "s");
    setInterval(() => { checarGatewaySilente(); }, GW_PROBE_CHECAGEM_MS);
    log("vigia de gateway mudo ligado: polla o probe do renderer a cada " + Math.round(GW_PROBE_CHECAGEM_MS / 1000) + "s");
    setInterval(() => { checarRtcNativo(); }, VOICE_PROBE_MS);
    log("vigia de video nativo ligado: polla discord_voice a cada " + Math.round(VOICE_PROBE_MS / 1000) + "s");
}

try {
    const discordPkg = require(join(asarPath, "package.json"));
    require.main.filename = join(asarPath, discordPkg.main);
    app.setAppPath(asarPath);
} catch (error) {
    // Sem o Discord original nao ha o que fazer, e travar aqui deixaria o usuario sem app.
    console.error("[GoLiveBypass] nao achei o Discord original em " + asarPath, error);
    throw error;
}

app.whenReady().then(() => {
    // O preload do shim precisa estar registrado ANTES de o Discord criar as
    // janelas (issue #169: registrar dentro do start() async chegava tarde e a
    // janela nascia sem o shim — "shim ausente neste documento"). O nosso
    // whenReady roda ANTES do handler do Discord (registramos o .then antes do
    // require dele), entao registrar aqui, sincronamente, garante que o preload
    // de sessao esta no ar quando a primeira janela for criada.
    registrarPreloadShim();

    // Nada aguarda isto de proposito: o Discord carrega em paralelo, e o gateway que chegar
    // antes da saida espera no roteador em vez de segurar a abertura inteira.
    start().catch(error => log("falhei ao preparar o bypass: " + error.message));

    try {
        patchNewerSiblings(resourcesDir);
    } catch (error) {
        log("falhei ao procurar versao nova: " + error.message);
    }

    // Monitoramento permanente de novas versoes do Discord: se o Discord baixar um update em segundo plano,
    // ele ja fica preparado automaticamente antes do proximo reinicio!
    setInterval(() => {
        try {
            patchNewerSiblings(resourcesDir);
        } catch { }
    }, 30000);
});

log("carregando o Discord original");
try {
    require(require.main.filename);
} catch (error) {
    // O Legcord (e quem mais empacotar o app como ESM com top-level await) nao carrega por
    // require — o import() dinamico cobre os dois mundos.
    if (error && (error.code === "ERR_REQUIRE_ASYNC_MODULE" || error.code === "ERR_REQUIRE_ESM")) {
        import(require.main.filename).catch((importError) => {
            console.error("[GoLiveBypass] nao consegui carregar o Discord original por import: " + importError.message);
            throw importError;
        });
    } else {
        throw error;
    }
}
