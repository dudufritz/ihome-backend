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
const { getUserTuya, buscarStatusEmLote } = require('../services/tuya.service');
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

        // UMA pergunta para todos os aparelhos deste usuário.
        //
        // Antes era uma chamada por dispositivo, a cada ciclo, para sempre.
        // Com 20 aparelhos e o ciclo de 5 minutos, davam 5.760 chamadas por
        // DIA — sozinhas, mais que a cota mensal da avaliação gratuita da
        // Tuya. Quando a cota acabava, a API parava de responder e o app
        // inteiro parecia quebrado.
        let porId;
        try {
          porId = await buscarStatusEmLote(devResult.rows.map((d) => d.tuya_id), ID, SECRET, BASE);
        } catch (e) {
          // A Tuya recusou a conversa inteira (cota, credencial, rede).
          //
          // Pular o ciclo é deliberado, e é uma correção de comportamento: no
          // desenho antigo, uma recusa dessas fazia TODOS os aparelhos caírem
          // no catch e virava uma enxurrada de alertas de "ficou offline" —
          // sobre aparelhos que estavam ligados o tempo todo. O usuário
          // recebia vinte notificações falsas e perdia a confiança nas
          // verdadeiras. Sem resposta da Tuya não dá para afirmar nada sobre
          // a casa; o certo é não afirmar.
          console.error(`Monitor: Tuya indisponível para ${user_email}:`, e.message);
          continue;
        }

        for (const device of devResult.rows) {
          // Presente na resposta = acessível. Ausente = a Tuya não soube
          // responder por ele, que é a mesma leitura que a consulta
          // individual fazia quando falhava.
          const acessivel = porId.has(device.tuya_id);

          const cache = await pool.query(
            'SELECT online FROM device_status_cache WHERE user_email = $1 AND device_id = $2',
            [user_email, device.tuya_id]
          );

          if (acessivel) {
            // Transição offline → online: avisa que voltou.
            if (cache.rows.length > 0 && cache.rows[0].online === false) {
              await emitirAlerta(
                user_email, device, 'online',
                `${device.name} voltou a ficar online.`, '✅ Dispositivo online'
              );
            }
            await atualizarCache(user_email, device.tuya_id, true);
          } else if (cache.rows.length === 0 || cache.rows[0].online === true) {
            // Alerta só na primeira detecção (sem cache) ou na transição online → offline.
            await emitirAlerta(
              user_email, device, 'offline',
              `${device.name} ficou offline.`, '⚠️ Dispositivo offline'
            );
            await atualizarCache(user_email, device.tuya_id, false);
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
