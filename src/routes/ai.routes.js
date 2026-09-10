/**
 * routes/ai.routes.js — Assistente em linguagem natural.
 *
 * O modelo apenas INTERPRETA; a execução é feita aqui, com validação.
 * Toda ação que chega a mexer num dispositivo passa pela auditoria, senão o
 * assistente viraria um caminho para agir sem deixar rastro.
 */
const express = require('express');
const { pool } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { limitadorIa } = require('../middleware/security');
const { asyncHandler } = require('../utils/http');
const { getUserTuya, tuyaRequest } = require('../services/tuya.service');
const { interpretCommand, resolveDevice } = require('../services/ai.service');
const { recordAudit, describeCommands } = require('../services/audit.service');

const router = express.Router();

/** Monta o comando Tuya de liga/desliga a partir do estado pedido. */
function switchCommand(state) {
  return [{ code: 'switch_1', value: state === true }];
}

/*
 * Limitador do assistente. Vem DEPOIS do authMiddleware de propósito: assim
 * a contagem usa o e-mail do usuário (definido por ele) em vez do IP, e o
 * teto atinge quem gastou a cota, não todos que compartilham a mesma rede.
 */
router.post('/ai-command', authMiddleware, limitadorIa(), asyncHandler(async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando não fornecido.' });

  // Contexto do prompt: o assistente só conhece os dispositivos deste usuário.
  const devResult = await pool.query(
    'SELECT * FROM user_devices WHERE user_email = $1',
    [req.user.email]
  );
  const devices = devResult.rows;

  if (devices.length === 0) {
    return res.json({
      message: 'Você não tem dispositivos cadastrados ainda. Adicione seus dispositivos em Configurações.',
    });
  }

  let parsed;
  try {
    parsed = await interpretCommand(devices, command);
  } catch (err) {
    console.error('AI error:', err.message);
    return res.status(500).json({ error: 'Erro ao processar: ' + err.message });
  }

  // ── Ligar/desligar um dispositivo específico ──
  if (parsed.action === 'control') {
    // Validação essencial: o ID precisa estar na lista real do usuário.
    // Protege contra alucinação do modelo e contra prompt injection embutida
    // no nome de um dispositivo.
    const device = resolveDevice(devices, parsed.deviceId);
    if (!device) {
      return res.json({ message: 'Não encontrei esse dispositivo na sua casa. Pode repetir o nome?' });
    }

    const commands = switchCommand(parsed.state);
    try {
      const config = await getUserTuya(req.user.email);
      await tuyaRequest(
        'POST', `/v1.0/iot-03/devices/${device.tuya_id}/commands`,
        config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
        { commands }
      );
      await recordAudit(req, {
        homeOwnerEmail: req.user.email, action: 'device.command',
        deviceId: device.tuya_id, deviceName: device.name,
        details: { commands, summary: describeCommands(commands), via: 'assistente' },
        result: 'success',
      });
    } catch (err) {
      await recordAudit(req, {
        homeOwnerEmail: req.user.email, action: 'device.command',
        deviceId: device.tuya_id, deviceName: device.name,
        details: { commands, summary: describeCommands(commands), via: 'assistente' },
        result: 'error', errorMessage: err.message,
      });
      throw err; // asyncHandler transforma em 500
    }
    return res.json({ message: parsed.message });
  }

  // ── Ligar/desligar todos ──
  if (parsed.action === 'control_all') {
    const config = await getUserTuya(req.user.email);
    const commands = switchCommand(parsed.state);

    // Em paralelo, e com .catch por dispositivo: um aparelho fora do ar não
    // deve impedir que os outros respondam ao comando.
    await Promise.all(devices.map((d) =>
      tuyaRequest(
        'POST', `/v1.0/iot-03/devices/${d.tuya_id}/commands`,
        config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
        { commands }
      ).catch(() => {})
    ));

    await recordAudit(req, {
      homeOwnerEmail: req.user.email, action: 'device.command_all',
      details: {
        commands, summary: describeCommands(commands),
        via: 'assistente', deviceCount: devices.length,
      },
      result: 'success',
    });
    return res.json({ message: parsed.message });
  }

  // ── Criar rotina agendada ──
  if (parsed.action === 'schedule') {
    const device = resolveDevice(devices, parsed.deviceId);
    if (!device) {
      return res.json({ message: 'Não encontrei esse dispositivo para agendar. Pode repetir o nome?' });
    }
    await pool.query(
      'INSERT INTO user_schedules (user_email, device_id, device_name, on_time, off_time) VALUES ($1, $2, $3, $4, $5)',
      [req.user.email, device.tuya_id, device.name, parsed.onTime || null, parsed.offTime || null]
    );
    return res.json({ message: parsed.message });
  }

  // ── 'list' e 'unknown': só devolvem a mensagem do modelo ──
  return res.json({ message: parsed.message });
}));

module.exports = router;
