/**
 * src/app.js — Montagem da aplicação Express.
 *
 * Separado do index.js de propósito: aqui o app é apenas CONSTRUÍDO, sem
 * abrir porta nem iniciar temporizadores. É isso que permite aos testes
 * importarem o app e dispararem requisições em memória (supertest), sem
 * precisar de um servidor de verdade nem de um banco real.
 */
const express = require('express');
const routes = require('./routes');
const { securityHeaders, corsRestrito, limitadorGlobal } = require('./middleware/security');

const app = express();

// ── MIDDLEWARES GLOBAIS ──
// A ordem importa: tudo aqui roda ANTES das rotas, e nesta sequência.

/*
 * 1. Confiança no proxy.
 *
 * Precisa vir primeiro, porque o rate limiting depende de req.ip estar
 * correto. Em produção o app roda atrás do proxy do App Service, e o IP
 * real do cliente chega no cabeçalho X-Forwarded-For.
 *
 * O valor é 1, e não `true`: `true` mandaria confiar na cadeia inteira de
 * proxies, o que permitiria a qualquer cliente forjar o próprio IP
 * inserindo um X-Forwarded-For falso — e assim escapar do rate limiting.
 * Com 1, confiamos apenas no salto mais próximo, que é o nosso.
 */
app.set('trust proxy', 1);

// 2. Cabeçalhos de segurança. Antes de qualquer resposta ser montada,
//    inclusive as de erro.
app.use(securityHeaders());

// 3. CORS restrito: só o frontend conhecido pode chamar a API pelo navegador.
app.use(corsRestrito());

// 4. Teto geral de requisições, como rede de proteção contra abuso amplo.
//    Rotas sensíveis têm limites próprios, mais estritos, definidos nelas.
app.use(limitadorGlobal());

// 5. Converte corpo JSON em req.body. O limite de 1MB é proteção simples
//    contra payloads absurdos — nenhuma rota do iHome recebe algo próximo.
app.use(express.json({ limit: '1mb' }));

// ── ROTAS ──
app.use(routes);

// ── 404 ──
// Declarado por último: só chega aqui o que nenhuma rota acima atendeu.
app.use((req, res) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
});

// ── TRATADOR DE ERROS ──
// Assinatura de 4 parâmetros: é assim que o Express reconhece um error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Origem bloqueada pelo CORS não é um defeito do servidor: é a proteção
  // funcionando. Responde 403, e não 500, para não poluir os alertas.
  if (err.message === 'Origem não autorizada pelo CORS') {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }

  console.error('❌ Erro não tratado:', err.message);
  if (res.headersSent) return;
  res.status(err.statusCode || 500).json({ error: err.message || 'Erro interno do servidor' });
});

module.exports = { app };
