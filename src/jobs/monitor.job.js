/**
 * jobs/monitor.job.js — Monitoramento de conectividade dos dispositivos.
 *
 * A Tuya não nos avisa quando um aparelho cai; precisamos perguntar. A cada
 * 5 minutos consultamos o estado de todos os dispositivos de todos os
 * usuários que têm credenciais configuradas.
 *
 * DETALHE CENTRAL DO ALGORITMO: alertamos sobre TRANSIÇÃO, não sobre estado.
 * A tabela device_status_cache guarda o último estado conhecido; só geramos
 * alerta quando o estado atual difere dele. Sem isso, um dispositivo desligado
 * da tomada geraria um alerta a cada 5 minutos, para sempre.
 */
const { pool } = require('../config/database');
const { getUserTuya, tuyaRequest } = require('../services/tuya.service');
const { sendPushToUser } = require('../services/push.service');

/** Grava o alerta no banco e dispara a notificação push correspondente. */
async function emitirAlerta(userEmail, device, tipo, mensagem, tituloPush) {
  await pool.query(
    'INSERT INTO user_alerts (user_email, device_id, device_name, type, message) VALUES ($1, $2, $3, $4, $5)',
    [userEmail, device.tuya_id, device.name, tipo, mensagem]
  );
  await sendPushToUser(userEmail, tituloPush, mensagem);
}

/** Atualiza (ou cria) a linha de cache com o estado atual do dispositivo. */
async function atualizarCache(userEmail, deviceId, online) {
  await pool.query(
    `INSERT INTO device_status_cache (user_email, device_id, online, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_email, device_id) DO UPDATE SET online = $3, updated_at = NOW()`,
    [userEmail, deviceId, online]
  );
}

async function monitorDevices() {
  try {
    // Só usuários que têm dispositivos E credenciais: o JOIN elimina quem
    // cadastrou aparelhos mas nunca configurou a Tuya.
    const usersResult = await pool.query(
      'SELECT DISTINCT ud.user_email FROM user_devices ud JOIN user_tuya_config utc ON ud.user_email = utc.user_email'
    );

    for (const { user_email } of usersResult.rows) {
      // try por usuário: credencial inválida de um não interrompe os demais.
      try {
        const config = await getUserTuya(user_email);
        const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;
        const devResult = await pool.query('SELECT * FROM user_devices WHERE user_email = $1', [user_email]);

        for (const device of devResult.rows) {
          try {
            // Se a consulta responde, o dispositivo está acessível.
            await tuyaRequest('GET', `/v1.0/iot-03/devices/${device.tuya_id}/status`, ID, SECRET, BASE);

            const cache = await pool.query(
              'SELECT online FROM device_status_cache WHERE user_email = $1 AND device_id = $2',
              [user_email, device.tuya_id]
            );

            // Transição offline → online: avisa que voltou.
            if (cache.rows.length > 0 && cache.rows[0].online === false) {
              await emitirAlerta(
                user_email, device, 'online',
                `${device.name} voltou a ficar online.`, '✅ Dispositivo online'
              );
            }
            await atualizarCache(user_email, device.tuya_id, true);
          } catch {
            // A consulta falhou: tratamos como dispositivo fora do ar.
            const cache = await pool.query(
              'SELECT online FROM device_status_cache WHERE user_email = $1 AND device_id = $2',
              [user_email, device.tuya_id]
            );

            // Alerta só na primeira detecção (sem cache) ou na transição online → offline.
            if (cache.rows.length === 0 || cache.rows[0].online === true) {
              await emitirAlerta(
                user_email, device, 'offline',
                `${device.name} ficou offline.`, '⚠️ Dispositivo offline'
              );
              await atualizarCache(user_email, device.tuya_id, false);
            }
          }
        }
      } catch (e) {
        console.error(`Monitor erro para ${user_email}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Monitor geral erro:', err.message);
  }
}

module.exports = { monitorDevices };
