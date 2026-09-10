/**
 * routes/auth.routes.js — Endpoints de autenticação.
 *
 * PRINCÍPIO QUE ATRAVESSA TODO O ARQUIVO: não vazar quais e-mails têm conta.
 * Login, recuperação de senha e reenvio de confirmação respondem sempre a
 * mesma coisa, exista ou não a conta. Um atacante que descobre "este e-mail
 * é cliente do iHome" já ganhou metade do trabalho — sabe onde aplicar
 * força bruta e o que usar em phishing.
 */
const express = require('express');
const { pool } = require('../config/database');
const { env } = require('../config/env');
const { asyncHandler } = require('../utils/http');
const { normalizeEmail, isValidEmail } = require('../utils/email');
const { authMiddleware } = require('../middleware/auth');
const { limitadorAuth } = require('../middleware/security');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../services/mail.service');
const auth = require('../services/auth.service');

const router = express.Router();

/*
 * Limitador aplicado às rotas que recebem ou validam credenciais.
 *
 * Só as tentativas que FALHAM contam (skipSuccessfulRequests), então quem
 * acerta a senha nunca esbarra no teto. Quem erra dez vezes na janela é
 * barrado — que é exatamente o padrão de um ataque de força bruta.
 */
const limiteCredenciais = limitadorAuth();

/** Formato único de resposta de sessão, para o frontend não ter dois caminhos. */
function respostaDeSessao(user, accessToken, refreshToken) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: auth.usuarioPublico(user),
  };
}

/**
 * POST /auth/register — cria uma conta.
 *
 * Nota sobre o e-mail já cadastrado: aqui o 409 é assumido conscientemente,
 * porque um formulário de cadastro precisa dizer ao usuário que o endereço
 * já existe — do contrário ele fica preso sem entender o motivo. A
 * informação já é obtível pelo próprio fluxo de cadastro em qualquer site;
 * o que protegemos de verdade são o login e a recuperação de senha.
 */
router.post('/auth/register', limiteCredenciais, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password, full_name: fullName, cpf, phone } = req.body;

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  const erroSenha = auth.validarSenha(password);
  if (erroSenha) return res.status(400).json({ error: erroSenha });

  const jaExiste = await auth.buscarPorEmail(email);
  if (jaExiste) {
    return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
  }

  const passwordHash = await auth.hashPassword(password);
  const criado = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, cpf, phone)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      email,
      passwordHash,
      fullName || null,
      // Guardamos só os dígitos: a máscara é responsabilidade da interface.
      cpf ? String(cpf).replace(/\D/g, '') : null,
      phone ? String(phone).replace(/\D/g, '') : null,
    ]
  );
  const user = criado.rows[0];

  // Envia a confirmação de e-mail. Uma falha de SMTP não desfaz o cadastro:
  // a conta já existe e o usuário pode pedir o reenvio depois.
  try {
    const token = await auth.emitirTokenDeUsoUnico(user.id, 'verify_email', env.verifyTokenHours * 60);
    await sendVerificationEmail({ email: user.email, token });
  } catch (e) {
    console.error('❌ Falha ao enviar e-mail de confirmação:', e.message);
  }

  // Já devolvemos a sessão: exigir confirmação antes do primeiro acesso
  // travaria o usuário caso o e-mail demorasse ou caísse em spam.
  const accessToken = auth.signAccessToken(user);
  const refreshToken = await auth.emitirRefreshToken(user.id);
  res.status(201).json(respostaDeSessao(user, accessToken, refreshToken));
}));

/**
 * POST /auth/login — autentica e devolve o par de tokens.
 *
 * A mesma mensagem para "e-mail não existe" e "senha errada" é intencional,
 * e a comparação bcrypt roda mesmo quando o usuário não existe (ver
 * HASH_FICTICIO no auth.service) para que os dois casos levem o mesmo tempo.
 */
router.post('/auth/login', limiteCredenciais, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  const user = await auth.buscarPorEmail(email);
  const senhaConfere = await auth.verifyPassword(password || '', user?.password_hash);

  if (!user || !senhaConfere) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  const accessToken = auth.signAccessToken(user);
  const refreshToken = await auth.emitirRefreshToken(user.id);
  res.json(respostaDeSessao(user, accessToken, refreshToken));
}));

/**
 * POST /auth/refresh — troca o refresh token por um par novo.
 * Rota pública de propósito: é chamada justamente quando o access token
 * já expirou e não serve mais para autenticar.
 */
router.post('/auth/refresh', asyncHandler(async (req, res) => {
  const resultado = await auth.rotacionarRefreshToken(req.body.refresh_token);
  if (!resultado.ok) return res.status(401).json({ error: resultado.reason });

  res.json(respostaDeSessao(resultado.user, resultado.accessToken, resultado.refreshToken));
}));

/**
 * POST /auth/logout — encerra a sessão deste dispositivo.
 * Revoga apenas o refresh token enviado; as outras sessões continuam.
 */
router.post('/auth/logout', asyncHandler(async (req, res) => {
  await auth.revogarRefreshToken(req.body.refresh_token);
  res.json({ success: true });
}));

/**
 * POST /auth/forgot-password — envia o link de redefinição.
 *
 * Responde 200 SEMPRE, mesmo para e-mail inexistente. É aqui que a proteção
 * contra enumeração mais importa: este endpoint é público e sem custo para
 * o atacante, então uma resposta diferente por conta existente entregaria
 * a lista inteira de clientes.
 */
router.post('/auth/forgot-password', limiteCredenciais, asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const resposta = { success: true, message: 'Se houver uma conta com este e-mail, enviamos as instruções.' };

  const user = await auth.buscarPorEmail(email);
  if (!user) return res.json(resposta); // some silenciosamente

  try {
    const token = await auth.emitirTokenDeUsoUnico(user.id, 'password_reset', env.resetTokenMinutes);
    await sendPasswordResetEmail({ email: user.email, token });
  } catch (e) {
    console.error('❌ Falha ao enviar e-mail de redefinição:', e.message);
  }

  res.json(resposta);
}));

/**
 * POST /auth/reset-password — troca a senha usando o token do e-mail.
 *
 * Revogar todas as sessões depois da troca é essencial: se a senha foi
 * redefinida porque a conta estava comprometida, deixar as sessões antigas
 * ativas manteria o invasor conectado apesar da nova senha.
 */
router.post('/auth/reset-password', limiteCredenciais, asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  const erroSenha = auth.validarSenha(password);
  if (erroSenha) return res.status(400).json({ error: erroSenha });

  const userId = await auth.consumirTokenDeUsoUnico(token, 'password_reset');
  if (!userId) {
    return res.status(400).json({ error: 'Link inválido ou expirado. Solicite um novo.' });
  }

  const passwordHash = await auth.hashPassword(password);
  await pool.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [passwordHash, userId]
  );
  await auth.revogarTodosDoUsuario(userId);

  res.json({ success: true, message: 'Senha redefinida. Faça login com a nova senha.' });
}));

/**
 * GET /auth/verify-email/:token — confirma o e-mail pelo link.
 * Redireciona para o frontend em vez de devolver JSON: quem chega aqui é
 * um navegador vindo do cliente de e-mail, não a aplicação.
 */
router.get('/auth/verify-email/:token', asyncHandler(async (req, res) => {
  const userId = await auth.consumirTokenDeUsoUnico(req.params.token, 'verify_email');
  if (!userId) return res.redirect(`${env.frontendUrl}?verify=invalid`);

  await pool.query('UPDATE users SET email_verified = true, updated_at = NOW() WHERE id = $1', [userId]);
  res.redirect(`${env.frontendUrl}?verify=success`);
}));

/** GET /auth/me — dados do usuário autenticado. Serve para validar a sessão. */
router.get('/auth/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = await auth.buscarPorEmail(req.user.email);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json({ user: auth.usuarioPublico(user) });
}));

module.exports = router;
