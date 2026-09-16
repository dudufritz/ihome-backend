/**
 * routes/health.routes.js — Rotas públicas de diagnóstico.
 * Não exigem autenticação: são consultadas por monitoramento externo
 * (New Relic, health check do App Service) antes de qualquer login existir.
 */
const express = require('express');
const { env } = require('../config/env');
const { isPushReady } = require('../services/push.service');

const router = express.Router();

// Confirma que a API subiu.
router.get('/', (req, res) => res.json({ message: 'iHome API online ✅' }));

/**
 * GET /health — a instância está viva e configurada?
 *
 * `ok` responde a primeira pergunta e é o que o health check da plataforma
 * observa. O objeto `config` responde a segunda.
 *
 * POR QUE EXPOR ISSO: processo no ar e processo funcionando são coisas
 * diferentes. Sem `DATABASE_URL` ou `JWT_SECRET` o servidor sobe normalmente,
 * responde `ok: true`, e nenhum login funciona — falha silenciosa que só
 * aparece quando alguém tenta entrar. Os avisos existem no boot, mas vivem no
 * log do App Service, que ninguém abre. Aqui a resposta cabe numa URL.
 *
 * O QUE NÃO ESTÁ AQUI, DE PROPÓSITO:
 *
 *   - Nenhum valor. Só `true` ou `false` para cada item. Saber que existe uma
 *     JWT_SECRET não ajuda ninguém a descobrir qual é.
 *
 *   - O estado da ENCRYPTION_KEY. Este ficou de fora por um motivo diferente
 *     dos outros: dizer que ela está ausente revela que os segredos Tuya estão
 *     em texto puro no banco — informação sobre a proteção dos dados em
 *     repouso, que um atacante não teria como observar de fora. Os demais
 *     campos apenas confirmam algo já perceptível: quem tentar fazer login
 *     descobre em um segundo que a autenticação não funciona. Essa é a
 *     diferença entre um diagnóstico útil e uma dica.
 */
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    push: isPushReady(),
    config: {
      database: Boolean(env.databaseUrl),
      auth: Boolean(env.jwtSecret),
      frontendUrl: Boolean(process.env.FRONTEND_URL),
      ai: Boolean(env.geminiApiKey),
      email: Boolean(env.gmailUser),
    },
  });
});

// A chave PÚBLICA VAPID pode ser exposta: é justamente com ela que o
// navegador cria a assinatura de push. A privada nunca sai do servidor.
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: isPushReady() ? (process.env.VAPID_PUBLIC_KEY || '') : '' });
});

module.exports = router;
