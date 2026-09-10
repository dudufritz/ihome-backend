/**
 * routes/audit.routes.js — Consulta ao registro de auditoria.
 *
 * A cláusula de visibilidade (AUDIT_SCOPE) é sempre a PRIMEIRA condição do
 * WHERE e usa $1 = e-mail do usuário autenticado. Os filtros vindos da query
 * string só podem restringir o conjunto — nunca ampliá-lo. Não existe
 * parâmetro capaz de fazer alguém enxergar a casa de um terceiro.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { AUDIT_SCOPE, RESULTADOS } = require('../services/audit.service');

const router = express.Router();

// Limites de paginação. O teto evita que alguém peça 1 milhão de linhas
// numa única requisição e derrube a memória do processo.
const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 500;

/**
 * GET /audit-log/actors — e-mails distintos que aparecem no log visível.
 * Serve para montar o menu de filtro por usuário no frontend.
 *
 * Declarada ANTES de /audit-log não por necessidade (os caminhos são
 * distintos), mas por clareza de leitura: rotas mais específicas primeiro.
 */
router.get('/audit-log/actors', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT DISTINCT actor_email FROM audit_log
     WHERE ${AUDIT_SCOPE} ORDER BY actor_email`,
    [req.user.email]
  );
  res.json(result.rows.map((r) => r.actor_email));
}));

/**
 * GET /audit-log — consulta com filtros e paginação.
 *
 * Query string aceita: actor, result, from, to, q, limit, offset.
 *
 * O WHERE é montado dinamicamente, mas TODO valor entra como parâmetro
 * numerado ($1, $2, ...) — nunca concatenado na string SQL. É isso que
 * torna injeção de SQL impossível aqui, mesmo com filtros variáveis.
 */
router.get('/audit-log', authMiddleware, asyncHandler(async (req, res) => {
  const { actor, result: resultFilter, from, to, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || LIMITE_PADRAO, LIMITE_MAXIMO);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  // params[0] é sempre o e-mail do usuário: a âncora da visibilidade.
  const params = [req.user.email];
  let where = AUDIT_SCOPE;

  if (actor) {
    params.push(actor);
    where += ` AND actor_email = $${params.length}`;
  }
  // Só aceitamos valores da lista branca: um filtro desconhecido é ignorado
  // em vez de gerar erro, porque a tela não deve quebrar por um parâmetro velho.
  if (resultFilter && RESULTADOS.includes(resultFilter)) {
    params.push(resultFilter);
    where += ` AND result = $${params.length}`;
  }
  if (from) {
    params.push(from);
    where += ` AND created_at >= $${params.length}::timestamptz`;
  }
  if (to) {
    // "+ 1 day" com "<" inclui o dia inteiro informado: quem filtra até
    // 31/01 espera ver o que aconteceu às 23h do dia 31.
    params.push(to);
    where += ` AND created_at < ($${params.length}::timestamptz + INTERVAL '1 day')`;
  }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length; // o mesmo parâmetro é reaproveitado nos 4 campos
    where += ` AND (device_name ILIKE $${i} OR actor_email ILIKE $${i}
                    OR device_id ILIKE $${i} OR details->>'summary' ILIKE $${i})`;
  }

  // Total sem paginação, para a tela mostrar "1–50 de 320".
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM audit_log WHERE ${where}`, params
  );

  // limit e offset entram só agora, para não afetarem a contagem acima.
  params.push(limit, offset);
  const rows = await pool.query(
    `SELECT id, home_owner_email, actor_email, action, device_id, device_name,
            details, result, error_message, ip_address, created_at
     FROM audit_log
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ total: countRes.rows[0]?.total ?? 0, limit, offset, entries: rows.rows });
}));

module.exports = router;
