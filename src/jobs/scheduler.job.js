/**
 * jobs/scheduler.job.js — Execução das rotinas agendadas.
 *
 * Roda uma vez por minuto. Formata o horário atual como "HH:MM" e compara com
 * on_time/off_time gravados no mesmo formato — comparação de texto, simples e
 * sem dependência de biblioteca de datas.
 *
 * Limitação conhecida e assumida: o horário é o do relógio do SERVIDOR. Com o
 * app implantado em região brasileira isso coincide com o do usuário. Uma
 * evolução natural seria guardar o fuso de cada usuário e converter aqui.
 */
const { pool } = require('../config/database');
const { tuyaRequest } = require('../services/tuya.service');
const { decrypt } = require('../services/crypto.service');

/** Devolve o horário atual como "HH:MM", com zero à esquerda. */
function horaAtual() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

async function runSchedules() {
  try {
    const currentTime = horaAtual();

    // O JOIN traz as credenciais junto para não precisar de uma consulta por
    // agendamento. tuya_secret vem cifrado e é decifrado logo abaixo.
    const result = await pool.query(
      `SELECT s.*, c.tuya_access_id, c.tuya_secret, c.tuya_base_url
       FROM user_schedules s
       JOIN user_tuya_config c ON s.user_email = c.user_email
       WHERE s.active = true`
    );

    for (const s of result.rows) {
      const ligaAgora = s.on_time === currentTime;
      const desligaAgora = s.off_time === currentTime;
      if (!ligaAgora && !desligaAgora) continue; // nada a fazer neste minuto

      let secret;
      try {
        secret = decrypt(s.tuya_secret);
      } catch (e) {
        console.error(`Agendamento: falha ao decifrar credencial de ${s.user_email}:`, e.message);
        continue;
      }

      if (ligaAgora) {
        await tuyaRequest(
          'POST', `/v1.0/iot-03/devices/${s.device_id}/commands`,
          s.tuya_access_id, secret, s.tuya_base_url,
          { commands: [{ code: 'switch_1', value: true }] }
        ).catch((e) => console.error('Agendamento ON erro:', e.message));
        console.log(`⏰ Ligou: ${s.device_name}`);
      }

      if (desligaAgora) {
        await tuyaRequest(
          'POST', `/v1.0/iot-03/devices/${s.device_id}/commands`,
          s.tuya_access_id, secret, s.tuya_base_url,
          { commands: [{ code: 'switch_1', value: false }] }
        ).catch((e) => console.error('Agendamento OFF erro:', e.message));
        console.log(`⏰ Desligou: ${s.device_name}`);
      }
    }
  } catch (err) {
    console.error('Cron erro:', err.message);
  }
}

module.exports = { runSchedules, horaAtual };
