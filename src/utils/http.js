/**
 * utils/http.js — Auxiliares comuns às rotas HTTP.
 */

/**
 * Envolve um handler assíncrono para que exceções não tratadas virem
 * respostas 500 em vez de derrubarem o processo.
 *
 * Sem isto, cada rota precisa do próprio try/catch. Com isto, um `throw`
 * dentro do handler é capturado e transformado numa resposta JSON.
 *
 * @param {Function} handler função async (req, res) da rota
 */
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error(`❌ ${req.method} ${req.originalUrl}:`, err.message);
      if (res.headersSent) return; // resposta já começou a ser enviada
      res.status(err.statusCode || 500).json({ error: err.message });
    });
  };
}

/**
 * Descobre o IP real do cliente.
 *
 * Em produção o app roda atrás do proxy do App Service, então req.ip
 * seria sempre o IP do proxy. O IP verdadeiro vem no cabeçalho
 * X-Forwarded-For, no formato "cliente, proxy1, proxy2" — interessa o primeiro.
 */
function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || null;
}

/**
 * Cria um Error já com o código HTTP desejado, para ser lançado dentro
 * de um asyncHandler e virar a resposta correta automaticamente.
 */
function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { asyncHandler, clientIp, httpError };
