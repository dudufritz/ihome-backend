/**
 * routes/devices.routes.js — Leitura de estado e envio de comandos.
 *
 * É o coração funcional do app: aqui a intenção do usuário vira uma chamada
 * assinada para a nuvem Tuya, e aqui mora a verificação de permissão em
 * casas compartilhadas.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { getUserTuya, tuyaRequest } = require('../services/tuya.service');
const { resolveHomeAccess } = require('../services/sharing.service');
const { recordAudit, describeCommands } = require('../services/audit.service');

const router = express.Router();

/**
 * GET /devices — dispositivos do usuário com o estado atual de cada um.
 *
 * As consultas de estado vão para a Tuya em PARALELO (Promise.all): com 10
 * dispositivos e 300ms por chamada, em série seriam 3 segundos; em paralelo,
 * ~300ms. Cada chamada tem o próprio try/catch, então um dispositivo fora do
 * ar aparece como offline em vez de derrubar a lista inteira.
 */
router.get('/devices', authMiddleware, asyncHandler(async (req, res) => {
  let config;
  try {
    config = await getUserTuya(req.user.email);
  } catch (err) {
    // Ainda não configurou credenciais: é erro do cliente (400), não do servidor.
    const status = err.message.includes('não configuradas') ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }

  const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;

  const devResult = await pool.query(
    'SELECT * FROM user_devices WHERE user_email = $1',
    [req.user.email]
  );

  const list = await Promise.all(devResult.rows.map(async (d) => {
    // Campos comuns aos dois desfechos (online e offline)
    const base = {
      id: d.tuya_id, dbId: d.id, name: d.name,
      category_name: 'Switch', room: d.room, isControllable: true,
    };
    try {
      const s = await tuyaRequest('GET', `/v1.0/iot-03/devices/${d.tuya_id}/status`, ID, SECRET, BASE);
      // A Tuya devolve [{code,value},...]; viramos num objeto para consulta direta.
      const statusMap = {};
      (s?.result || []).forEach((item) => { statusMap[item.code] = item.value; });
      return { ...base, online: true, switch_1: statusMap.switch_1 === true };
    } catch {
      return { ...base, online: false, switch_1: false };
    }
  }));

  res.json({ result: { list }, success: true });
}));

/**
 * POST /devices/:id/command — liga ou desliga um dispositivo.
 *
 * Fluxo:
 *   1. resolve em qual casa a ação acontece e se o usuário pode executá-la;
 *   2. busca as credenciais Tuya do DONO da casa (não as de quem clicou);
 *   3. envia o comando assinado;
 *   4. registra o resultado na auditoria — inclusive quando é negado.
 *
 * O passo 4 acontece nos três desfechos de propósito: uma tentativa negada é
 * justamente o evento que o dono da casa mais precisa conseguir enxergar.
 */
router.post('/devices/:id/command', authMiddleware, asyncHandler(async (req, res) => {
  const { commands, owner_email } = req.body;
  const deviceId = req.params.id;

  // Casa onde a ação ocorre. Começa como a própria e muda se for compartilhada.
  let homeOwner = req.user.email;

  // Declarado FORA do try para que o bloco catch também o enxergue. Se
  // ficasse dentro, o registro de auditoria de uma falha perderia o nome do
  // dispositivo — justamente no caso em que saber qual dispositivo falhou
  // é o que mais importa.
  let deviceName = null;

  try {
    // ── 1. Autorização ──
    const acesso = await resolveHomeAccess(req.user.email, owner_email, 'control');
    homeOwner = acesso.homeOwnerEmail;

    // Nome amigável do dispositivo, buscado ANTES da bifurcação de permissão.
    // Precisa vir aqui para que a tentativa NEGADA também registre qual
    // dispositivo alguém tentou acionar — sem isso o dono veria apenas
    // "Ligou — (sem nome)" justamente no evento que mais lhe interessa.
    // Falha aqui não impede nada: o nome é informação acessória.
    try {
      const dev = await pool.query(
        'SELECT name FROM user_devices WHERE user_email = $1 AND tuya_id = $2 LIMIT 1',
        [homeOwner, deviceId]
      );
      deviceName = dev.rows[0]?.name || null;
    } catch { /* nome é opcional */ }

    if (!acesso.allowed) {
      // O summary vai junto mesmo na negativa: sem ele a tela mostraria
      // "Comando enviado" genérico, e a busca textual não encontraria as
      // tentativas negadas — que são justamente as que mais interessam.
      await recordAudit(req, {
        homeOwnerEmail: homeOwner, action: 'device.command', deviceId, deviceName,
        details: { commands, summary: describeCommands(commands) },
        result: 'denied', errorMessage: acesso.reason,
      });
      return res.status(acesso.status || 403).json({ error: acesso.reason });
    }

    // ── 2. Credenciais do dono da casa ──
    const config = await getUserTuya(homeOwner);

    // ── 3. Execução ──
    const data = await tuyaRequest(
      'POST',
      `/v1.0/iot-03/devices/${deviceId}/commands`,
      config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
      { commands }
    );

    // ── 4. Auditoria (sucesso) ──
    await recordAudit(req, {
      homeOwnerEmail: homeOwner, action: 'device.command', deviceId, deviceName,
      details: { commands, summary: describeCommands(commands) },
      result: 'success',
    });

    res.json(data);
  } catch (err) {
    // ── 4. Auditoria (falha) ──
    await recordAudit(req, {
      homeOwnerEmail: homeOwner, action: 'device.command', deviceId, deviceName,
      details: { commands, summary: describeCommands(commands) },
      result: 'error', errorMessage: err.message,
    });
    res.status(500).json({ error: err.message });
  }
}));

/**
 * GET /devices/:id/status — estado de um dispositivo específico.
 *
 * Aceita owner_email para funcionar também com dispositivos compartilhados.
 * Exige apenas permissão 'view', porque consultar não altera nada.
 */
router.get('/devices/:id/status', authMiddleware, asyncHandler(async (req, res) => {
  const acesso = await resolveHomeAccess(req.user.email, req.query.owner_email, 'view');
  if (!acesso.allowed) {
    return res.status(acesso.status || 403).json({ error: acesso.reason });
  }

  const config = await getUserTuya(acesso.homeOwnerEmail);
  const data = await tuyaRequest(
    'GET',
    `/v1.0/iot-03/devices/${req.params.id}/status`,
    config.tuya_access_id, config.tuya_secret, config.tuya_base_url
  );
  res.json(data);
}));

module.exports = router;
