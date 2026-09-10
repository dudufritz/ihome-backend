/**
 * routes/schedules.routes.js — Rotinas agendadas.
 * A criação acontece pelo assistente de IA (/ai-command); aqui o usuário
 * apenas consulta e remove.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.get('/schedules', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM user_schedules WHERE user_email = $1 AND active = true ORDER BY created_at DESC',
    [req.user.email]
  );
  res.json(result.rows);
}));

router.delete('/schedules/:id', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM user_schedules WHERE id = $1 AND user_email = $2',
    [req.params.id, req.user.email]
  );
  res.json({ success: true });
}));

module.exports = router;
