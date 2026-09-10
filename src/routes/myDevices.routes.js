/**
 * routes/myDevices.routes.js — Cadastro de dispositivos no iHome.
 *
 * Diferença importante em relação a /devices:
 *   - /my-devices  → o que está gravado no NOSSO banco (cadastro);
 *   - /devices     → o mesmo, porém consultando o estado real na Tuya.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { getUserTuya, tuyaRequest } = require('../services/tuya.service');

const router = express.Router();

/**
 * GET /my-devices — dispositivos próprios + os de casas compartilhadas comigo.
 *
 * São duas consultas porque a origem é diferente:
 *   1. os meus, filtrados por user_email;
 *   2. os das casas que me compartilharam, obtidos por JOIN com home_shares.
 * O filtro status='accepted' garante que um convite ainda não respondido não
 * exponha os dispositivos de ninguém.
 *
 * access_type ('own' | 'shared') diz ao frontend como renderizar o cartão.
 */
router.get('/my-devices', authMiddleware, asyncHandler(async (req, res) => {
  const own = await pool.query(
    "SELECT *, user_email as owner_email, 'own' as access_type FROM user_devices WHERE user_email = $1 ORDER BY created_at",
    [req.user.email]
  );

  const shared = await pool.query(
    `SELECT ud.*, ud.user_email as owner_email, 'shared' as access_type, hs.permission
     FROM home_shares hs
     JOIN user_devices ud ON ud.user_email = hs.owner_email
     WHERE hs.guest_email = $1 AND hs.status = 'accepted'
     ORDER BY ud.created_at`,
    [req.user.email]
  );

  res.json([...own.rows, ...shared.rows]);
}));

/** POST /my-devices — traz um dispositivo da conta Tuya para o iHome. */
router.post('/my-devices', authMiddleware, asyncHandler(async (req, res) => {
  const { tuya_id, name, room } = req.body;
  if (!tuya_id || !name) {
    return res.status(400).json({ error: 'ID do dispositivo e nome são obrigatórios' });
  }

  const result = await pool.query(
    'INSERT INTO user_devices (user_email, tuya_id, name, room) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.user.email, tuya_id, name, room || '']
  );
  res.json(result.rows[0]);
}));

/**
 * DELETE /my-devices/:id — remove o cadastro (o dispositivo continua na Tuya).
 *
 * O AND user_email = $2 é o que impede IDOR: mesmo que alguém descubra o id
 * numérico de outro usuário, a linha não casa com o e-mail dele e nada é
 * apagado. É o mesmo padrão em todas as rotas que recebem um id na URL.
 */
router.delete('/my-devices/:id', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM user_devices WHERE id = $1 AND user_email = $2',
    [req.params.id, req.user.email]
  );
  res.json({ success: true });
}));

/**
 * GET /discover-devices — lista tudo que existe na conta Tuya do usuário.
 *
 * A API da Tuya pagina os resultados com last_row_key. Percorremos no máximo
 * 10 páginas de 100 itens: é um limite de segurança para a requisição não
 * ficar presa num laço caso a API devolva sempre uma chave de continuação.
 */
router.get('/discover-devices', authMiddleware, asyncHandler(async (req, res) => {
  const config = await getUserTuya(req.user.email);
  const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;

  let allDevices = [];
  let lastRowKey = '';
  for (let page = 0; page < 10; page++) {
    const url = `/v1.0/iot-03/devices?page_size=100${lastRowKey ? `&last_row_key=${lastRowKey}` : ''}`;
    const result = await tuyaRequest('GET', url, ID, SECRET, BASE);
    const list = result?.result?.devices || result?.result || [];
    if (!Array.isArray(list) || list.length === 0) break;
    allDevices = allDevices.concat(list);
    if (!result?.result?.last_row_key) break; // não há próxima página
    lastRowKey = result.result.last_row_key;
  }

  // Marca o que o usuário já cadastrou, para a tela desabilitar o botão "adicionar".
  const saved = await pool.query('SELECT tuya_id FROM user_devices WHERE user_email = $1', [req.user.email]);
  const savedIds = new Set(saved.rows.map((r) => r.tuya_id)); // Set → busca O(1)

  const devices = allDevices.map((d) => ({
    tuya_id: d.id,
    name: d.name || d.local_key || d.id,
    category: d.category,
    product_name: d.product_name || '',
    online: d.online ?? false,
    already_added: savedIds.has(d.id),
  }));

  res.json({ devices });
}));

module.exports = router;
