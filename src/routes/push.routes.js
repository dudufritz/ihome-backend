/**
 * routes/push.routes.js — Assinaturas de notificação push.
 *
 * O navegador gera um objeto de assinatura (endpoint + chaves) e o envia
 * para cá. Guardamos como JSONB para depois usá-lo no envio.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

/**
 * POST /push-subscribe — registra este navegador para receber notificações.
 *
 * O DELETE antes do INSERT evita duplicatas: o navegador pode reenviar a
 * mesma assinatura (após um F5, por exemplo) e sem isso o usuário receberia
 * a mesma notificação duas vezes. O endpoint é extraído de dentro do JSONB
 * com o operador ->> , que devolve o campo como texto.
 */
router.post('/push-subscribe', authMiddleware, asyncHandler(async (req, res) => {
  const { subscription } = req.body;

  await pool.query(
    "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
    [req.user.email, subscription.endpoint]
  );
  await pool.query(
    'INSERT INTO push_subscriptions (user_email, subscription) VALUES ($1, $2)',
    [req.user.email, JSON.stringify(subscription)]
  );

  res.json({ success: true });
}));

/** DELETE /push-subscribe — o usuário desativou as notificações. */
router.delete('/push-subscribe', authMiddleware, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  await pool.query(
    "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
    [req.user.email, endpoint]
  );
  res.json({ success: true });
}));

module.exports = router;
