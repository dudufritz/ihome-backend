/**
 * middleware/auth.js — Verificação do token em cada requisição.
 *
 * COMO FUNCIONA
 * O usuário faz login em /auth/login e recebe um access token (JWT). O
 * frontend o envia em toda requisição no cabeçalho:
 *
 *     Authorization: Bearer <token>
 *
 * Este middleware confere a assinatura e a validade. Se estiver tudo certo,
 * preenche req.user e libera a rota; caso contrário responde 401.
 *
 * POR QUE ISTO É A FRONTEIRA DE CONFIANÇA
 * Tudo que vem depois daqui confia em req.user.email — inclusive o
 * isolamento multi-inquilino, já que todas as consultas filtram por esse
 * e-mail. Um erro aqui não vaza uma rota: vaza o sistema inteiro. Por isso
 * o e-mail é normalizado neste ponto, e em nenhum outro, garantindo que
 * todas as comparações SQL usem a mesma forma canônica.
 *
 * O token é assinado com HS256 — o raciocínio dessa escolha está
 * documentado em services/auth.service.js.
 */
const { verifyAccessToken } = require('../services/auth.service');
const { normalizeEmail } = require('../utils/email');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token não fornecido' });

  // Formato esperado: "Bearer <token>". Sem o espaço, [1] vem undefined.
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });

  try {
    const decoded = verifyAccessToken(token);
    req.user = {
      id: decoded.sub,                        // id do usuário na tabela users
      email: normalizeEmail(decoded.email),   // chave do isolamento multi-inquilino
    };
    if (!req.user.email) {
      return res.status(401).json({ error: 'Token inválido.' });
    }
    return next();
  } catch (err) {
    // jsonwebtoken distingue token expirado de token adulterado. A diferença
    // importa para o cliente: expirado significa "use o refresh token";
    // inválido significa "faça login de novo".
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada.', code: 'token_expired' });
    }
    return res.status(401).json({ error: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

module.exports = { authMiddleware };
