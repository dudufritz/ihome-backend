/**
 * routes/health.routes.js — Rotas públicas de diagnóstico.
 * Não exigem autenticação: são consultadas por monitoramento externo
 * (New Relic, health check do App Service) antes de qualquer login existir.
 */
const express = require('express');
const { isPushReady } = require('../services/push.service');

const router = express.Router();

// Confirma que a API subiu.
router.get('/', (req, res) => res.json({ message: 'iHome API online ✅' }));

// Usado pelo health check da plataforma para decidir se a instância está viva.
router.get('/health', (req, res) => res.json({ ok: true, push: isPushReady() }));

// A chave PÚBLICA VAPID pode ser exposta: é justamente com ela que o
// navegador cria a assinatura de push. A privada nunca sai do servidor.
router.get('/vapid-public-key', (req, res) => {
  res.json({ key: isPushReady() ? (process.env.VAPID_PUBLIC_KEY || '') : '' });
});

module.exports = router;
