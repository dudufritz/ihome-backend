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
 * Percorre um endpoint paginado da Tuya e devolve tudo que ele listar.
 *
 * A Tuya pagina com `last_row_key`: cada resposta traz a chave da próxima
 * página. O teto de 10 páginas (1.000 dispositivos) é proteção — se a API
 * devolver sempre uma chave de continuação, o laço para em vez de prender a
 * requisição para sempre.
 *
 * @param {(chave: string) => string} montarUrl monta a URL com a chave de página
 */
async function listarPaginado(montarUrl, ID, SECRET, BASE) {
  let todos = [];
  let chave = '';
  for (let pagina = 0; pagina < 10; pagina++) {
    const resposta = await tuyaRequest('GET', montarUrl(chave), ID, SECRET, BASE);
    const lista = resposta?.result?.devices || resposta?.result || [];
    if (!Array.isArray(lista) || lista.length === 0) break;
    todos = todos.concat(lista);
    if (!resposta?.result?.last_row_key) break; // acabaram as páginas
    chave = resposta.result.last_row_key;
  }
  return todos;
}

/**
 * GET /discover-devices — lista tudo que existe na conta Tuya do usuário.
 *
 * POR QUE SÃO DUAS CONSULTAS, E NESTA ORDEM:
 *
 * A Tuya expõe dispositivos por dois caminhos, conforme a origem deles:
 *
 *   1. `/v1.0/iot-01/associated-users/devices` — dispositivos que chegaram
 *      pelo vínculo com uma conta do app (Smart Life / Tuya Smart), feito em
 *      "Devices → Link Tuya App Account". É o caso de quem já usava o app no
 *      celular antes de criar o projeto, que é praticamente todo mundo.
 *
 *   2. `/v1.0/iot-03/devices` — dispositivos cadastrados DIRETAMENTE no
 *      projeto da nuvem, sem passar pelo app. Comum em projetos industriais.
 *
 * O código consultava apenas o segundo. Numa conta com dezenas de dispositivos
 * vindos do Smart Life, ele respondia com sucesso e uma lista vazia — o pior
 * tipo de falha, porque parece que a conta é que está vazia. A tela então
 * sugeria verificar o vínculo, que já estava correto.
 *
 * Consultamos o primeiro e, só se ele nada trouxer, o segundo. A ordem segue a
 * frequência real: a maioria dos usuários vem pelo app.
 */
router.get('/discover-devices', authMiddleware, asyncHandler(async (req, res) => {
  const config = await getUserTuya(req.user.email);
  const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;

  // 1. Dispositivos vindos da conta do app vinculada ao projeto.
  let allDevices = await listarPaginado(
    (chave) => `/v1.0/iot-01/associated-users/devices?page_size=100${chave ? `&last_row_key=${chave}` : ''}`,
    ID, SECRET, BASE
  );

  // 2. Só se o primeiro caminho não trouxe nada: dispositivos do próprio projeto.
  if (allDevices.length === 0) {
    allDevices = await listarPaginado(
      (chave) => `/v1.0/iot-03/devices?page_size=100${chave ? `&last_row_key=${chave}` : ''}`,
      ID, SECRET, BASE
    );
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
