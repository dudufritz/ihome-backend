/**
 * utils/email.js — Tratamento de endereços de e-mail.
 *
 * Por que isto existe: o e-mail é a CHAVE que liga usuário, dispositivos e
 * compartilhamentos no banco. Se o dono convida "Fulano@Gmail.com" e o
 * convidado faz login como "fulano@gmail.com", as comparações SQL (que são
 * sensíveis a maiúsculas) nunca casam e o compartilhamento simplesmente
 * não funciona. Normalizar num único lugar elimina essa classe de bug.
 */

/**
 * Converte um e-mail para a forma canônica: sem espaços nas pontas e minúsculo.
 * @param {*} value valor cru vindo do corpo da requisição ou do token JWT
 * @returns {string|null} e-mail normalizado, ou null se não for texto
 */
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const limpo = value.trim().toLowerCase();
  return limpo.length > 0 ? limpo : null;
}

/**
 * Validação de formato de e-mail.
 * Proposital e deliberadamente simples: exige "algo@algo.algo" sem espaços.
 * O objetivo é barrar erro de digitação, não validar a RFC 5322 inteira —
 * a prova real de que o endereço existe é o convite chegar na caixa de entrada.
 */
function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = { normalizeEmail, isValidEmail };
