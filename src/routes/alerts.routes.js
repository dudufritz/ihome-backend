/**
 * routes/alerts.routes.js — Alertas de conectividade dos dispositivos.
 * As linhas são criadas pelo job de monitoramento (jobs/monitor.job.js);
 * estas rotas apenas leem e limpam.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

// LIMIT 50: a tela mostra os mais recentes; sem o limite, um usuário com
// meses de histórico traria milhares de linhas a cada abertura.
router.get('/alerts', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM user_alerts WHERE user_email = $1 ORDER BY created_at DESC LIMIT 50',
    [req.user.email]
  );
  res.json(result.rows);
}));

// Marca todos como lidos — chamado quando o usuário abre a aba de alertas,
// o que zera o contador vermelho da navegação.
router.put('/alerts/read-all', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query('UPDATE user_alerts SET read = true WHERE user_email = $1', [req.user.email]);
  res.json({ success: true });
}));

router.delete('/alerts', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM user_alerts WHERE user_email = $1', [req.user.email]);
  res.json({ success: true });
}));

module.exports = router;
