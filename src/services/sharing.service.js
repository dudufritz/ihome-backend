/**
 * services/sharing.service.js — Regras de acesso a casas compartilhadas.
 *
 * MODELO DE AUTORIZAÇÃO
 * Cada casa pertence a um dono (owner_email). O dono pode convidar outras
 * pessoas (guest_email) com um de dois níveis:
 *   - 'view'    → apenas enxerga os dispositivos e seus estados;
 *   - 'control' → também pode ligar e desligar.
 *
 * O convite só vale depois de aceito (status = 'accepted'). Esta regra vive
 * aqui, num único lugar, exatamente para não ser esquecida em alguma rota —
 * foi assim que surgiu a falha corrigida abaixo.
 */
const { pool } = require('../config/database');
const { normalizeEmail } = require('../utils/email');

/** Níveis de permissão aceitos. Qualquer outro valor é rejeitado na entrada. */
const PERMISSOES_VALIDAS = ['view', 'control'];

/**
 * Resolve em qual casa uma ação deve acontecer e se o usuário pode realizá-la.
 *
 * @param {string} actorEmail    quem está fazendo a requisição (do token JWT)
 * @param {string} [ownerEmail]  dono da casa alvo; ausente = a própria casa
 * @param {'view'|'control'} nivelExigido  permissão mínima necessária
 * @returns {Promise<{allowed: boolean, homeOwnerEmail: string, reason?: string, status?: number}>}
 */
async function resolveHomeAccess(actorEmail, ownerEmail, nivelExigido = 'control') {
  const ator = normalizeEmail(actorEmail);
  const dono = normalizeEmail(ownerEmail);

  // Caso simples: o usuário está agindo na própria casa. Dono pode tudo.
  if (!dono || dono === ator) {
    return { allowed: true, homeOwnerEmail: ator };
  }

  // Caso compartilhado: precisa existir um convite ACEITO ligando os dois.
  //
  // ⚠️ CORREÇÃO DE SEGURANÇA: a versão anterior consultava home_shares apenas
  // por owner_email + guest_email, sem checar o status. Consequência: bastava
  // ter sido convidado — mesmo sem nunca aceitar — para já controlar a casa.
  // O filtro status = 'accepted' fecha essa brecha.
  const share = await pool.query(
    `SELECT permission FROM home_shares
     WHERE owner_email = $1 AND guest_email = $2 AND status = 'accepted'`,
    [dono, ator]
  );

  if (share.rows.length === 0) {
    return {
      allowed: false,
      homeOwnerEmail: dono,
      status: 403,
      reason: 'Acesso negado',
    };
  }

  const permissao = share.rows[0].permission;

  // 'control' satisfaz qualquer exigência; 'view' só satisfaz exigência de leitura.
  const atende = nivelExigido === 'view' ? true : permissao === 'control';
  if (!atende) {
    return {
      allowed: false,
      homeOwnerEmail: dono,
      status: 403,
      reason: 'Você tem apenas permissão de visualização',
      permission: permissao,
    };
  }

  return { allowed: true, homeOwnerEmail: dono, permission: permissao };
}

module.exports = { resolveHomeAccess, PERMISSOES_VALIDAS };
