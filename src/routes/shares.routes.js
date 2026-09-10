/**
 * routes/shares.routes.js — Compartilhamento de casa entre usuários.
 *
 * FLUXO DO CONVITE
 *   1. o dono chama POST /shares informando o e-mail do convidado;
 *   2. gravamos a linha com status 'pending' e um token aleatório;
 *   3. enviamos um e-mail com dois links contendo esse token;
 *   4. clicar em "aceitar" muda o status para 'accepted' — só aí o acesso vale.
 *
 * O token tem 32 bytes de entropia (crypto.randomBytes), inviável de adivinhar,
 * e as rotas de aceite/recusa são públicas de propósito: quem clica no link
 * está no e-mail, e é isso que prova a identidade do convidado.
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { env } = require('../config/env');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');
const { normalizeEmail, isValidEmail } = require('../utils/email');
const { PERMISSOES_VALIDAS } = require('../services/sharing.service');
const { sendInviteEmail } = require('../services/mail.service');

const router = express.Router();

/** GET /shares — quem tem (ou foi convidado a ter) acesso à minha casa. */
router.get('/shares', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM home_shares WHERE owner_email = $1 ORDER BY created_at DESC',
    [req.user.email]
  );
  res.json(result.rows);
}));

/**
 * GET /shared-with-me — casas de terceiros às quais eu tenho acesso.
 * O LEFT JOIN com COUNT informa quantos dispositivos cada casa possui,
 * para a tela mostrar "Casa de fulano — 6 dispositivos".
 */
router.get('/shared-with-me', authMiddleware, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT hs.*, COUNT(ud.id)::int as device_count
     FROM home_shares hs
     LEFT JOIN user_devices ud ON ud.user_email = hs.owner_email
     WHERE hs.guest_email = $1 AND hs.status = 'accepted'
     GROUP BY hs.id ORDER BY hs.created_at DESC`,
    [req.user.email]
  );
  res.json(result.rows);
}));

/**
 * POST /shares — convidar alguém.
 *
 * Validações antes de gravar:
 *   - e-mail em formato plausível (evita convite que nunca chegará);
 *   - não convidar a si mesmo;
 *   - permissão restrita a 'view' ou 'control' — sem isto, qualquer string
 *     seria aceita e ficaria guardada no banco sem significado.
 *
 * O e-mail é normalizado para minúsculas: é o que garante que o convite
 * enviado para "Fulano@Gmail.com" case com o login "fulano@gmail.com".
 */
router.post('/shares', authMiddleware, asyncHandler(async (req, res) => {
  const guestEmail = normalizeEmail(req.body.guest_email);
  const permission = req.body.permission || 'control';

  if (!guestEmail) return res.status(400).json({ error: 'E-mail do convidado é obrigatório' });
  if (!isValidEmail(guestEmail)) return res.status(400).json({ error: 'E-mail do convidado é inválido' });
  if (guestEmail === req.user.email) return res.status(400).json({ error: 'Você não pode convidar a si mesmo' });
  if (!PERMISSOES_VALIDAS.includes(permission)) {
    return res.status(400).json({ error: "Permissão deve ser 'view' ou 'control'" });
  }

  // 32 bytes aleatórios em hexadecimal = 64 caracteres imprevisíveis
  const token = crypto.randomBytes(32).toString('hex');
  const expiraEm = new Date(Date.now() + env.inviteExpiryDays * 24 * 60 * 60 * 1000);

  // Reconvidar a mesma pessoa reinicia o convite: novo token, volta a
  // pending e o prazo recomeça — inclusive se o convite anterior expirou.
  const result = await pool.query(
    `INSERT INTO home_shares (owner_email, guest_email, permission, status, invite_token, invite_expires_at)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     ON CONFLICT (owner_email, guest_email) DO UPDATE
       SET permission = $3, status = 'pending', invite_token = $4, invite_expires_at = $5
     RETURNING *`,
    [req.user.email, guestEmail, permission, token, expiraEm]
  );

  // O convite já está gravado. Se o e-mail falhar, registramos e seguimos:
  // desfazer o convite por causa de uma indisponibilidade do SMTP seria pior.
  let emailSent = true;
  try {
    await sendInviteEmail({
      ownerEmail: req.user.email, guestEmail, permission, token,
    });
  } catch (mailErr) {
    emailSent = false;
    console.error('❌ Erro ao enviar e-mail de convite:', mailErr.message);
  }

  res.json({ ...result.rows[0], emailSent });
}));

/**
 * GET /shares/accept/:token — aceitar pelo link do e-mail (rota pública).
 *
 * A condição status='pending' torna a operação de uso único: um token já
 * aceito não muda mais nada, então reenviar o link não tem efeito colateral.
 * Ao final redirecionamos para o frontend, que exibe o aviso ao usuário.
 */
router.get('/shares/accept/:token', asyncHandler(async (req, res) => {
  // As três condições vivem no próprio UPDATE, e não num SELECT anterior.
  // Isso torna a operação atômica: dois cliques simultâneos no mesmo link
  // resultam numa única aceitação, sem janela de corrida entre ler e gravar.
  const result = await pool.query(
    `UPDATE home_shares SET status = 'accepted'
     WHERE invite_token = $1
       AND status = 'pending'
       AND (invite_expires_at IS NULL OR invite_expires_at > NOW())
     RETURNING *`,
    [req.params.token]
  );

  if (result.rowCount === 0) {
    // Não distinguimos "token inexistente" de "token expirado" na resposta:
    // a diferença só serviria para alguém confirmar que um token já existiu.
    return res.redirect(`${env.frontendUrl}?invite=invalid`);
  }
  res.redirect(`${env.frontendUrl}?invite=accepted`);
}));

/** GET /shares/decline/:token — recusar pelo link do e-mail (rota pública). */
router.get('/shares/decline/:token', asyncHandler(async (req, res) => {
  await pool.query(
    `DELETE FROM home_shares WHERE invite_token = $1 AND status = 'pending'`,
    [req.params.token]
  );
  res.redirect(`${env.frontendUrl}?invite=declined`);
}));

/** DELETE /shares/:id — o dono revoga o acesso de um convidado. */
router.delete('/shares/:id', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM home_shares WHERE id = $1 AND owner_email = $2',
    [req.params.id, req.user.email]
  );
  res.json({ success: true });
}));

/** DELETE /shared-with-me/:id — o convidado sai da casa por conta própria. */
router.delete('/shared-with-me/:id', authMiddleware, asyncHandler(async (req, res) => {
  await pool.query(
    'DELETE FROM home_shares WHERE id = $1 AND guest_email = $2',
    [req.params.id, req.user.email]
  );
  res.json({ success: true });
}));

module.exports = router;
