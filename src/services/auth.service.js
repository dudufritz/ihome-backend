/**
 * services/auth.service.js — Autenticação própria do iHome.
 *
 * ═══════════════════════════════════════════════════════════════
 *  DECISÕES DE PROJETO (as perguntas que este arquivo responde)
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. POR QUE HS256 E NÃO RS256?
 *    RS256 usa um par de chaves: assina com a privada, qualquer um verifica
 *    com a pública. Isso resolve um problema que aqui não existe — quem
 *    emite o token e quem o verifica são o MESMO serviço. RS256 traria
 *    distribuição de chave pública, endpoint JWKS e rotação para não ganhar
 *    nada. HS256, com um segredo forte que nunca sai do servidor, é a
 *    escolha correta para este desenho. Se um dia um segundo serviço
 *    precisar validar os tokens, aí sim vale migrar para RS256.
 *
 * 2. POR QUE DOIS TOKENS (ACCESS + REFRESH)?
 *    O access token é um JWT: o servidor valida a assinatura sem consultar
 *    o banco, o que o torna rápido — mas também impossível de revogar antes
 *    de expirar. Por isso ele dura só 15 minutos.
 *    O refresh token é opaco e vive no banco, então PODE ser revogado na
 *    hora. Ele dura 30 dias e serve apenas para obter novos access tokens.
 *    O par junta o desempenho de um com o controle do outro.
 *
 * 3. POR QUE GUARDAR O HASH DO REFRESH TOKEN?
 *    Se o banco vazar, tokens em texto puro seriam credenciais prontas para
 *    uso. Guardamos o SHA-256. Hash rápido basta aqui: o token tem 256 bits
 *    de entropia aleatória, então não há o que adivinhar por força bruta —
 *    diferente da senha, que é curta e escolhida por humanos e por isso
 *    exige bcrypt.
 *
 * 4. POR QUE ROTACIONAR O REFRESH TOKEN?
 *    A cada uso, o token antigo é queimado e um novo é emitido. Se alguém
 *    roubar um refresh token e usá-lo, o dono legítimo tentará usar o mesmo
 *    token depois e receberá erro — e é exatamente isso que detectamos em
 *    `detectarReuso`, revogando toda a sessão. Sem rotação, um token roubado
 *    valeria 30 dias em silêncio.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { env } = require('../config/env');
const { normalizeEmail } = require('../utils/email');

/**
 * Hash "descartável" usado quando o e-mail informado não existe.
 *
 * Sem isso, um login com e-mail inexistente responderia em ~1ms e um login
 * com e-mail existente em ~250ms (o custo do bcrypt). Essa diferença de
 * tempo permitiria descobrir quais e-mails têm conta — um ataque de
 * enumeração por temporização. Comparando sempre contra ALGUM hash, o
 * tempo de resposta fica equivalente nos dois casos.
 */
const HASH_FICTICIO = bcrypt.hashSync('senha-que-nunca-sera-usada', 10);

// ── SENHAS ───────────────────────────────────────────────────

/** Gera o hash bcrypt de uma senha. O salt é gerado e embutido pelo bcrypt. */
async function hashPassword(senha) {
  return bcrypt.hash(senha, env.bcryptRounds);
}

/** Compara senha digitada com o hash guardado, em tempo constante. */
async function verifyPassword(senha, hash) {
  return bcrypt.compare(senha, hash || HASH_FICTICIO);
}

/**
 * Regras mínimas de senha. Deliberadamente enxutas: exigir símbolo e
 * maiúscula leva o usuário a "Senha1!" — previsível. Comprimento é o
 * fator que mais aumenta a dificuldade real de quebra.
 */
function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    return 'A senha deve ter pelo menos 8 caracteres.';
  }
  if (senha.length > 200) {
    // bcrypt trunca em 72 bytes; limitar aqui evita processar entrada absurda.
    return 'A senha é longa demais.';
  }
  return null; // null = válida
}

// ── TOKENS ───────────────────────────────────────────────────

/** Gera um token opaco de 256 bits, em hexadecimal. */
function gerarTokenOpaco() {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 do token — é isto que vai para o banco, nunca o token em si. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Emite o access token (JWT).
 *
 * O campo `sub` (subject) carrega o id do usuário; `email` vai junto porque
 * é a chave usada em todas as consultas de isolamento multi-inquilino, e
 * lê-lo do token evita uma ida ao banco a cada requisição.
 */
function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email },
    env.jwtSecret,
    { algorithm: 'HS256', expiresIn: env.accessTokenTtl }
  );
}

/** Verifica um access token. Lança se a assinatura ou a validade falharem. */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] });
}

/**
 * Cria um refresh token e grava o hash dele no banco.
 * @returns {Promise<string>} o token em texto puro — só existe aqui e na
 *          resposta ao cliente; o banco fica apenas com o hash.
 */
async function emitirRefreshToken(userId) {
  const token = gerarTokenOpaco();
  const expira = new Date(Date.now() + env.refreshTokenDays * 24 * 60 * 60 * 1000);

  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expira]
  );
  return token;
}

/**
 * Troca um refresh token por um par novo (rotação).
 *
 * @returns {Promise<{ok:false,reason:string}|{ok:true,user:object,accessToken:string,refreshToken:string}>}
 */
async function rotacionarRefreshToken(token) {
  if (!token) return { ok: false, reason: 'Refresh token não fornecido' };

  const linha = await pool.query(
    `SELECT rt.*, u.email, u.full_name
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [hashToken(token)]
  );

  if (linha.rows.length === 0) {
    return { ok: false, reason: 'Refresh token inválido' };
  }

  const rt = linha.rows[0];

  // ── Detecção de reuso ──
  // O token existe mas já foi queimado. Ou é uma repetição inofensiva de
  // requisição, ou alguém está usando um token roubado. Não temos como
  // distinguir, então tratamos como comprometimento e derrubamos a sessão
  // inteira: o usuário legítimo faz login de novo, o atacante fica de fora.
  if (rt.revoked_at) {
    await revogarTodosDoUsuario(rt.user_id);
    return { ok: false, reason: 'Sessão encerrada por segurança. Faça login novamente.' };
  }

  if (new Date(rt.expires_at) < new Date()) {
    return { ok: false, reason: 'Sessão expirada. Faça login novamente.' };
  }

  // Queima o token atual e emite um novo par.
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [rt.id]);

  const user = { id: rt.user_id, email: rt.email, full_name: rt.full_name };
  return {
    ok: true,
    user,
    accessToken: signAccessToken(user),
    refreshToken: await emitirRefreshToken(rt.user_id),
  };
}

/** Revoga um refresh token específico (logout deste dispositivo). */
async function revogarRefreshToken(token) {
  if (!token) return;
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(token)]
  );
}

/** Revoga todas as sessões do usuário (troca de senha ou suspeita de roubo). */
async function revogarTodosDoUsuario(userId) {
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
}

// ── TOKENS DE USO ÚNICO (reset de senha, verificação de e-mail) ──

/**
 * Cria um token de uso único e devolve o valor em texto puro.
 * Tokens anteriores do mesmo propósito são invalidados: pedir um novo link
 * de redefinição deve tornar o anterior inútil.
 */
async function emitirTokenDeUsoUnico(userId, purpose, minutosDeValidade) {
  await pool.query(
    'UPDATE auth_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL',
    [userId, purpose]
  );

  const token = gerarTokenOpaco();
  const expira = new Date(Date.now() + minutosDeValidade * 60 * 1000);

  await pool.query(
    'INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, hashToken(token), purpose, expira]
  );
  return token;
}

/**
 * Consome um token de uso único: valida e marca como usado na mesma operação.
 *
 * O `AND used_at IS NULL` dentro do UPDATE é o que garante o uso único mesmo
 * sob concorrência — duas requisições simultâneas com o mesmo token: a
 * primeira atualiza a linha, a segunda não encontra mais nada para atualizar.
 * Fazer SELECT e depois UPDATE deixaria uma janela para as duas passarem.
 *
 * @returns {Promise<number|null>} o user_id, ou null se o token não servir
 */
async function consumirTokenDeUsoUnico(token, purpose) {
  if (!token) return null;

  const r = await pool.query(
    `UPDATE auth_tokens SET used_at = NOW()
     WHERE token_hash = $1 AND purpose = $2
       AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [hashToken(token), purpose]
  );
  return r.rows[0]?.user_id ?? null;
}

// ── USUÁRIOS ─────────────────────────────────────────────────

/** Busca um usuário pelo e-mail (já normalizado). */
async function buscarPorEmail(email) {
  const alvo = normalizeEmail(email);
  if (!alvo) return null;
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [alvo]);
  return r.rows[0] || null;
}

/** Busca um usuário pelo id. */
async function buscarPorId(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/**
 * Remove campos sensíveis antes de devolver o usuário ao cliente.
 * O password_hash jamais deve atravessar a fronteira da API.
 */
function usuarioPublico(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    phone: user.phone,
    email_verified: user.email_verified,
    created_at: user.created_at,
  };
}

module.exports = {
  hashPassword, verifyPassword, validarSenha,
  signAccessToken, verifyAccessToken,
  emitirRefreshToken, rotacionarRefreshToken,
  revogarRefreshToken, revogarTodosDoUsuario,
  emitirTokenDeUsoUnico, consumirTokenDeUsoUnico,
  buscarPorEmail, buscarPorId, usuarioPublico,
  gerarTokenOpaco, hashToken,
};
