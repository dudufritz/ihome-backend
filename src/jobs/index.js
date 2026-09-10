/**
 * jobs/index.js — Rotinas que rodam em segundo plano.
 *
 * Ficam separadas das rotas porque não são disparadas por requisição: são
 * temporizadores que o processo mantém vivos enquanto o servidor estiver de pé.
 *
 * Não são iniciadas em ambiente de teste — temporizadores pendentes deixam o
 * Jest sem encerrar e poluem as asserções sobre as chamadas ao banco.
 */
const { env } = require('../config/env');
const { monitorDevices } = require('./monitor.job');
const { runSchedules } = require('./scheduler.job');
const { purgeAuditLog } = require('../services/audit.service');

const UM_MINUTO = 60 * 1000;
const UM_DIA = 24 * 60 * 60 * 1000;

function startBackgroundJobs() {
  if (env.isTest) return; // sob teste, nada de temporizadores

  // Verifica conectividade dos dispositivos (padrão: 5 minutos).
  setInterval(monitorDevices, env.monitorIntervalMs);

  // Executa rotinas agendadas. Precisa ser de minuto em minuto porque a
  // granularidade dos horários cadastrados é o minuto.
  setInterval(runSchedules, UM_MINUTO);

  // Expurga registros de auditoria antigos, uma vez por dia.
  setInterval(purgeAuditLog, UM_DIA);

  console.log('⏱️  Rotinas em segundo plano iniciadas.');
}

module.exports = { startBackgroundJobs };
