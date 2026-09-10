/**
 * services/audit.service.js — Registro de auditoria.
 *
 * Responde a três perguntas sobre cada ação sensível: QUEM fez, O QUE fez e
 * QUANDO. Em uma casa compartilhada isso deixa de ser um detalhe: o dono
 * precisa conseguir descobrir qual convidado abriu o portão às 3h da manhã.
 */
const { pool } = require('../config/database');
const { env } = require('../config/env');
const { clientIp } = require('../utils/http');

/**
 * Cláusula de visibilidade, usada por todas as consultas ao log.
 *
 * O usuário enxerga uma linha quando:
 *   - a ação ocorreu na casa dele (home_owner_email) — vê tudo, inclusive
 *     o que convidados fizeram; ou
 *   - foi ele quem executou a ação (actor_email) — vê o próprio rastro,
 *     mesmo em casas de terceiros.
 *
 * Fica como constante para que nenhuma rota consulte audit_log sem o filtro.
 */
const AUDIT_SCOPE = '(home_owner_email = $1 OR actor_email = $1)';

/** Resultados possíveis de uma ação auditada. */
const RESULTADOS = ['success', 'error', 'denied'];

/**
 * Grava uma linha no registro de auditoria.
 *
 * DECISÃO DE PROJETO: esta função NUNCA lança exceção. Auditoria é um efeito
 * colateral da ação, não a ação em si — se o banco falhar na hora de gravar o
 * log, o usuário não pode receber erro por uma luz que de fato acendeu.
 * A falha é registrada no console e o fluxo segue.
 *
 * @param {import('express').Request} req requisição (para extrair ator, IP e user-agent)
 * @param {object} dados descrição da ação
 */
async function recordAudit(req, {
  homeOwnerEmail,
  action,
  deviceId = null,
  deviceName = null,
  details = null,
  result = 'success',
  errorMessage = null,
}) {
  try {
    const actor = req?.user?.email;
    // Sem ator, sem casa ou sem ação não há o que registrar de útil.
    if (!actor || !homeOwnerEmail || !action) return;

    const ua = req.headers?.['user-agent'] || null;

    await pool.query(
      `INSERT INTO audit_log
         (home_owner_email, actor_email, action, device_id, device_name,
          details, result, error_message, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        homeOwnerEmail,
        actor,
        action,
        deviceId,
        deviceName,
        details ? JSON.stringify(details) : null,
        RESULTADOS.includes(result) ? result : 'success',
        errorMessage,
        clientIp(req),
        // Corta o user-agent: navegadores enviam strings longas e não
        // queremos inchar a tabela por causa disso.
        ua ? String(ua).slice(0, 300) : null,
      ]
    );
  } catch (err) {
    console.error('⚠️ Falha ao gravar auditoria:', err.message);
  }
}

/**
 * Traduz um comando Tuya para uma frase legível em português.
 *
 * Guardamos o comando bruto em details.commands (para perícia técnica) e
 * este resumo em details.summary (para a tela). Assim a interface não
 * precisa saber que "switch_1 = true" significa "Ligou".
 */
function describeCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) return 'Comando enviado';
  return commands.map((c) => {
    if (c?.code === 'switch_1' || c?.code === 'switch') {
      if (c.value === true) return 'Ligou';
      if (c.value === false) return 'Desligou';
    }
    return `${c?.code} = ${JSON.stringify(c?.value)}`;
  }).join(', ');
}

/**
 * Apaga registros mais antigos que o período de retenção.
 *
 * Sem isto a tabela cresce para sempre: cada clique num interruptor é uma
 * linha. 90 dias cobrem o uso prático (investigar algo recente) sem
 * transformar o log no maior objeto do banco.
 */
async function purgeAuditLog() {
  try {
    const r = await pool.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
      [String(env.auditRetentionDays)]
    );
    if (r.rowCount > 0) {
      console.log(`🧹 Auditoria: ${r.rowCount} registro(s) acima de ${env.auditRetentionDays} dias removido(s).`);
    }
  } catch (err) {
    console.error('⚠️ Falha ao expurgar auditoria:', err.message);
  }
}

module.exports = { recordAudit, describeCommands, purgeAuditLog, AUDIT_SCOPE, RESULTADOS };
