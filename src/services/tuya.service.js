/**
 * services/tuya.service.js — Comunicação com a nuvem Tuya IoT.
 *
 * A Tuya não usa uma API key simples: cada requisição precisa de uma
 * ASSINATURA HMAC-SHA256 que prova que quem chamou conhece o secret, sem
 * jamais transmitir o secret pela rede. A assinatura cobre o método, o corpo,
 * o caminho e o horário — então ela não pode ser reaproveitada em outra
 * chamada nem repetida muito tempo depois.
 */
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../config/database');
const { decrypt } = require('./crypto.service');
const { normalizeEmail } = require('../utils/email');

/** Assina uma string com HMAC-SHA256; a Tuya exige o resultado em MAIÚSCULAS. */
function makeSign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}

/** SHA-256 do corpo da requisição (string vazia quando não há corpo). */
function sha256(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}

/**
 * Cache de tokens de acesso da Tuya, indexado pelo access_id.
 * Cada token vale ~2 horas; sem cache, gastaríamos uma chamada de
 * autenticação antes de cada operação.
 */
const tokenCache = {};

/**
 * Obtém um token de acesso, reaproveitando o do cache quando ainda válido.
 * Guardamos a expiração com 60s de margem para nunca usar um token que
 * vence no meio do caminho.
 */
async function getToken(accessId, accessSecret, baseUrl) {
  const cached = tokenCache[accessId];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const t = Date.now().toString(); // timestamp em milissegundos
  // String a assinar no fluxo SEM token: accessId + timestamp + resumo da requisição
  const s = accessId + t + ['GET', sha256(''), '', '/v1.0/token?grant_type=1'].join('\n');

  const res = await axios.get(`${baseUrl}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: accessId,
      sign: makeSign(accessSecret, s),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
    },
  });
  if (!res.data.success) {
    throw new Error('Falha ao autenticar na Tuya: ' + JSON.stringify(res.data));
  }

  tokenCache[accessId] = {
    token: res.data.result.access_token,
    expiry: Date.now() + (res.data.result.expire_time * 1000) - 60000, // margem de 1 min
  };
  return tokenCache[accessId].token;
}

/**
 * Executa uma requisição autenticada na API da Tuya.
 *
 * Detalhe crítico da assinatura: os parâmetros de query precisam estar em
 * ordem alfabética, senão a assinatura calculada aqui não bate com a
 * calculada do lado da Tuya e a chamada é rejeitada.
 */
async function tuyaRequest(method, path, accessId, accessSecret, baseUrl, body = null) {
  const token = await getToken(accessId, accessSecret, baseUrl);
  const t = Date.now().toString();

  const [urlPath, query] = path.split('?');
  const sortedQuery = query ? '?' + query.split('&').sort().join('&') : '';
  const bodyStr = body ? JSON.stringify(body) : '';

  // String a assinar no fluxo COM token: accessId + token + timestamp + resumo
  const s = accessId + token + t + [method, sha256(bodyStr), '', urlPath + sortedQuery].join('\n');

  const res = await axios({
    method,
    url: `${baseUrl}${path}`,
    headers: {
      client_id: accessId,
      access_token: token,
      sign: makeSign(accessSecret, s),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
      'Content-Type': 'application/json',
    },
    data: body || undefined,
  });

  console.log(`${method} ${path} — ok`);
  return res.data;
}

/**
 * Busca as credenciais Tuya de um usuário e já devolve o segredo DECIFRADO,
 * pronto para assinar requisições.
 *
 * Este é o único ponto do sistema que decifra o segredo. Manter a decifragem
 * concentrada aqui garante que nenhuma rota manipule o valor cifrado por engano.
 */
async function getUserTuya(email) {
  const alvo = normalizeEmail(email);
  const result = await pool.query('SELECT * FROM user_tuya_config WHERE user_email = $1', [alvo]);
  if (result.rows.length === 0) {
    throw new Error('Credenciais Tuya não configuradas. Acesse Configurações para cadastrá-las.');
  }
  const config = result.rows[0];
  // decrypt() devolve o valor intacto se a linha for antiga (texto puro),
  // o que permite a migração acontecer sem downtime.
  return { ...config, tuya_secret: decrypt(config.tuya_secret) };
}

module.exports = { makeSign, sha256, getToken, tuyaRequest, getUserTuya, tokenCache };
