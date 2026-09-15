/**
 * routes/credentials.routes.js — Credenciais da conta Tuya do usuário.
 *
 * Cada usuário cadastra as próprias credenciais do projeto Tuya. O iHome não
 * possui uma conta central: isso mantém os dispositivos sob a conta do dono e
 * evita que o serviço vire um ponto único de acesso a todas as casas.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { encrypt } = require('../services/crypto.service');
const { recordAudit } = require('../services/audit.service');

const router = express.Router();

/**
 * Mostra apenas os 4 últimos caracteres do Access ID: `••••••••a1b2`.
 *
 * O suficiente para o dono reconhecer qual credencial foi trocada, sem
 * transcrever o identificador inteiro para dentro do log. Vale a pena porque
 * a tabela de auditoria é lida por qualquer pessoa com quem a casa foi
 * compartilhada — ela não tem a mesma proteção de user_tuya_config.
 */
function mascararAccessId(accessId) {
  const texto = String(accessId || '');
  if (texto.length <= 4) return '••••';
  return '••••••••' + texto.slice(-4);
}

/**
 * GET /tuya-credentials — informa se já existe configuração.
 *
 * Note que o SELECT lista apenas access_id e base_url: o tuya_secret NUNCA
 * volta para o frontend, nem cifrado. Ele só é lido internamente, na hora
 * de assinar uma chamada para a Tuya.
 */
router.get('/tuya-credentials', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT tuya_access_id, tuya_base_url FROM user_tuya_config WHERE user_email = $1',
    [req.user.email]
  );
  if (result.rows.length === 0) return res.json({ configured: false });
  res.json({ configured: true, ...result.rows[0] });
}));

/**
 * POST /tuya-credentials — cadastra ou atualiza as credenciais.
 *
 * ON CONFLICT DO UPDATE: como user_email é UNIQUE, a mesma instrução serve
 * para inserir na primeira vez e atualizar nas seguintes (um "upsert"),
 * dispensando um SELECT prévio e a condição de corrida que ele traria.
 *
 * O segredo é cifrado com AES-256-GCM antes de tocar o banco.
 */
router.post('/tuya-credentials', authMiddleware, asyncHandler(async (req, res) => {
  const { tuya_access_id, tuya_secret, tuya_base_url } = req.body;
  if (!tuya_access_id || !tuya_secret) {
    return res.status(400).json({ error: 'Access ID e Secret são obrigatórios' });
  }

  await pool.query(`
    INSERT INTO user_tuya_config (user_email, tuya_access_id, tuya_secret, tuya_base_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_email) DO UPDATE
      SET tuya_access_id = $2, tuya_secret = $3, tuya_base_url = $4, updated_at = NOW()
  `, [
    req.user.email,
    tuya_access_id,
    encrypt(tuya_secret), // ← nunca gravado em texto puro
    tuya_base_url || 'https://openapi.tuyaus.com',
  ]);

  // Auditoria: trocar a credencial redireciona para onde os comandos da casa
  // são enviados. Quem controla essa chave controla os dispositivos, então a
  // troca precisa deixar rastro.
  //
  // ATENÇÃO AO QUE NÃO ESTÁ AQUI: `tuya_secret` não entra no details, nem
  // cifrado, nem mascarado, nem o tamanho dele. Cifrar o segredo no banco e
  // depois copiá-lo para a tabela de auditoria anularia a proteção inteira —
  // e a auditoria é visível para todo mundo com quem a casa foi compartilhada.
  await recordAudit(req, {
    homeOwnerEmail: req.user.email,
    action: 'credentials.update',
    details: {
      summary: 'Atualizou as credenciais Tuya',
      accessIdMascarado: mascararAccessId(tuya_access_id),
      baseUrl: tuya_base_url || 'https://openapi.tuyaus.com',
    },
    result: 'success',
  });

  res.json({ success: true });
}));

module.exports = router;
