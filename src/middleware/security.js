/**
 * middleware/security.js — Camada de proteção da API.
 *
 * Reúne três defesas independentes:
 *   1. helmet        — cabeçalhos HTTP de segurança;
 *   2. CORS restrito — só o frontend conhecido pode chamar a API;
 *   3. rate limiting — teto de requisições, por rota sensível.
 *
 * Nenhuma delas substitui as outras. O helmet instrui o navegador; o CORS
 * decide quais páginas podem falar com a API; o rate limiting decide quantas
 * vezes. Um atacante com curl ignora as duas primeiras — só a terceira o
 * atinge, e é por isso que as três coexistem.
 */
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

// ═══════════════════════════════════════════════════════════════
//  1. CABEÇALHOS DE SEGURANÇA
// ═══════════════════════════════════════════════════════════════

/**
 * O helmet define uma dezena de cabeçalhos. Os que importam aqui:
 *
 *  - X-Content-Type-Options: nosniff
 *      Impede o navegador de "adivinhar" o tipo do conteúdo. Sem isso, um
 *      JSON com conteúdo malicioso poderia ser interpretado como HTML.
 *  - Strict-Transport-Security
 *      Obriga HTTPS nas próximas visitas, fechando a janela em que a
 *      primeira requisição sairia em texto claro.
 *  - X-Frame-Options / frameguard
 *      Impede que a API seja embutida em iframe (clickjacking).
 *  - Remove X-Powered-By
 *      Deixava explícito "Express" na resposta — informação que só serve
 *      para quem procura exploits específicos da stack.
 *
 * A Content-Security-Policy fica DESLIGADA de propósito: ela governa o que
 * uma página pode carregar, e esta API não serve HTML. Quem precisa de CSP
 * é o frontend, que a define no staticwebapp.config.json.
 */
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // o frontend é outro domínio
    hsts: {
      maxAge: 31536000,       // 1 ano
      includeSubDomains: true,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
//  2. CORS RESTRITO
// ═══════════════════════════════════════════════════════════════

/**
 * Monta a lista de origens permitidas.
 *
 * Antes a API aceitava `cors()` sem argumento — qualquer site na internet
 * podia disparar requisições autenticadas a partir do navegador da vítima.
 * Agora só passam o frontend de produção, os endereços de desenvolvimento
 * e o que for declarado em CORS_EXTRA_ORIGINS.
 */
function origensPermitidas() {
  const lista = [env.frontendUrl, ...env.corsExtraOrigins];

  // Em desenvolvimento, libera o servidor local do Create React App.
  if (env.nodeEnv !== 'production') {
    lista.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }

  // Set remove duplicatas (frontendUrl pode repetir em CORS_EXTRA_ORIGINS).
  return [...new Set(lista.filter(Boolean))];
}

function corsRestrito() {
  const permitidas = origensPermitidas();

  return cors({
    origin(origin, callback) {
      // Sem cabeçalho Origin: é chamada servidor-a-servidor, curl, health
      // check da plataforma ou app mobile. CORS é uma proteção do NAVEGADOR;
      // bloquear aqui só quebraria monitoramento sem impedir ataque algum.
      if (!origin) return callback(null, true);

      if (permitidas.includes(origin)) return callback(null, true);

      console.warn(`⚠️ CORS bloqueou origem não autorizada: ${origin}`);
      return callback(new Error('Origem não autorizada pelo CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // o navegador guarda o preflight por 24h
  });
}

// ═══════════════════════════════════════════════════════════════
//  3. LIMITAÇÃO DE REQUISIÇÕES
// ═══════════════════════════════════════════════════════════════

/**
 * Fábrica de limitadores.
 *
 * @param {number} max      requisições permitidas na janela
 * @param {string} mensagem texto devolvido ao estourar o limite
 * @param {object} opcoes   ajustes adicionais
 */
function criarLimitador(max, mensagem, opcoes = {}) {
  return rateLimit({
    windowMs: env.rateLimitWindowMin * 60 * 1000,
    max,
    // Cabeçalhos RateLimit-* padronizados (RFC 9239), para o cliente saber
    // quanto ainda pode gastar. Os X-RateLimit-* legados ficam de fora.
    standardHeaders: 'draft-7',
    legacyHeaders: false,

    // Nos testes o limitador é ignorado: a suíte faz dezenas de logins
    // seguidos de propósito e estouraria qualquer teto realista.
    // O comportamento do limitador é verificado em security-extra.test.js,
    // que monta um app próprio com estes mesmos limites.
    skip: () => env.isTest,

    /**
     * Chave de contagem: o usuário autenticado quando há um, senão o IP.
     *
     * Por que não só o IP: uma faculdade ou operadora móvel coloca centenas
     * de pessoas atrás do mesmo endereço, e um usuário intenso bloquearia
     * todos os outros. Contando por usuário, o limite atinge quem o gastou.
     */
    keyGenerator: (req) => req.user?.email || req.ip,

    handler: (req, res) => {
      res.status(429).json({
        error: mensagem,
        code: 'rate_limited',
        retryAfterSeconds: env.rateLimitWindowMin * 60,
      });
    },

    ...opcoes,
  });
}

/** Teto geral, aplicado a todas as rotas. Rede de proteção contra abuso amplo. */
const limitadorGlobal = () => criarLimitador(
  env.rateLimitGlobal,
  'Muitas requisições. Aguarde alguns minutos e tente novamente.'
);

/**
 * Teto estrito para as rotas de autenticação.
 *
 * É a defesa contra força bruta de senha: sem ele, um atacante testaria
 * milhares de combinações por minuto contra /auth/login.
 *
 * skipSuccessfulRequests: só as tentativas que FALHAM contam. Assim quem
 * acerta a senha e navega normalmente nunca esbarra no limite, enquanto
 * quem erra seguidamente é barrado rápido.
 */
const limitadorAuth = () => criarLimitador(
  env.rateLimitAuth,
  'Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.',
  { skipSuccessfulRequests: true }
);

/**
 * Teto para o assistente de IA.
 *
 * Aqui a motivação é financeira antes de ser de segurança: cada chamada
 * consome cota paga da API do Gemini. Sem limite, um laço acidental no
 * frontend — ou um usuário mal-intencionado — drena a cota do projeto.
 */
const limitadorIa = () => criarLimitador(
  env.rateLimitAi,
  'Você fez muitos pedidos ao assistente. Aguarde alguns minutos.'
);

module.exports = {
  securityHeaders,
  corsRestrito,
  origensPermitidas,
  criarLimitador,
  limitadorGlobal,
  limitadorAuth,
  limitadorIa,
};
