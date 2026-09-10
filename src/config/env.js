/**
 * config/env.js — Ponto único de leitura das variáveis de ambiente.
 *
 * Por que centralizar: se cada arquivo chamasse process.env diretamente,
 * um erro de digitação em "DATABSE_URL" só apareceria em produção, na hora
 * da primeira query. Aqui tudo é lido uma vez, com valores padrão explícitos,
 * e o servidor avisa no boot o que está faltando.
 */
require('dotenv').config(); // carrega o arquivo .env para dentro de process.env

const env = {
  // ── Ambiente de execução ──
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3001,
  isTest: process.env.NODE_ENV === 'test',

  // ── Banco de dados ──
  databaseUrl: process.env.DATABASE_URL,

  // ── Autenticação (emitida pelo próprio iHome) ──
  // Segredo que assina e verifica os access tokens (HS256).
  // Trocá-lo invalida todas as sessões ativas — o que é exatamente o que
  // se quer fazer ao suspeitar que ele vazou.
  jwtSecret: process.env.JWT_SECRET,
  // Access token curto: se vazar, a janela de uso é pequena.
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  // Refresh token longo: é o que evita pedir a senha a cada 15 minutos.
  refreshTokenDays: parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || 30,
  // Custo do bcrypt. 12 é o equilíbrio atual entre segurança e latência
  // (~250ms por hash); aumentar encarece o ataque de força bruta na mesma
  // proporção em que encarece o login legítimo.
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,
  // Validade dos links de redefinição de senha e confirmação de e-mail.
  resetTokenMinutes: parseInt(process.env.RESET_TOKEN_MINUTES, 10) || 60,
  verifyTokenHours: parseInt(process.env.VERIFY_TOKEN_HOURS, 10) || 48,

  // ── Criptografia dos segredos Tuya guardados no banco ──
  // Deve ser uma chave de 32 bytes em hexadecimal (64 caracteres).
  // Gere com:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryptionKey: process.env.ENCRYPTION_KEY,

  // ── URLs públicas (usadas nos links do e-mail de convite) ──
  // Sem endereço de produção embutido: um valor errado geraria links de
  // convite e de redefinição apontando para lugar nenhum, e a falha só
  // apareceria na caixa de entrada do usuário.
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  // ── E-mail (Gmail SMTP) ──
  gmailUser: process.env.GMAIL_USER,
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD,

  // ── Web Push (VAPID) ──
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
  vapidEmail: process.env.VAPID_EMAIL || 'mailto:admin@ihomeauto.com',

  // ── Assistente de IA (Google Gemini) ──
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',

  // ── CORS ──
  // Origens extras além do frontendUrl (ambientes de preview, por exemplo).
  corsExtraOrigins: (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean),

  // ── Limitação de requisições ──
  rateLimitWindowMin: parseInt(process.env.RATE_LIMIT_WINDOW_MIN, 10) || 15,
  rateLimitGlobal: parseInt(process.env.RATE_LIMIT_GLOBAL, 10) || 300,
  rateLimitAuth: parseInt(process.env.RATE_LIMIT_AUTH, 10) || 10,
  rateLimitAi: parseInt(process.env.RATE_LIMIT_AI, 10) || 30,

  // ── Regras de negócio configuráveis ──
  auditRetentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 90,
  monitorIntervalMs: parseInt(process.env.MONITOR_INTERVAL_MS, 10) || 5 * 60 * 1000,
  inviteExpiryDays: parseInt(process.env.INVITE_EXPIRY_DAYS, 10) || 7,
};

/**
 * Avisa no boot sobre variáveis ausentes.
 * Não derruba o processo: o app funciona parcialmente sem push ou sem IA,
 * e é melhor subir degradado do que não subir. Só o banco é obrigatório.
 */
function checkEnv() {
  if (env.isTest) return; // nos testes tudo é mockado, não faz sentido avisar

  if (!env.databaseUrl) {
    console.error('❌ DATABASE_URL não definida — o servidor não conseguirá acessar o banco.');
  }
  if (!env.jwtSecret) {
    console.error('❌ JWT_SECRET não definida — nenhum login funcionará. Gere com: npm run gen:key');
  }
  const opcionais = [
    ['ENCRYPTION_KEY', env.encryptionKey, 'segredos Tuya ficarão em texto puro'],
    ['GEMINI_API_KEY', env.geminiApiKey, 'assistente de IA desativado'],
    ['VAPID_PUBLIC_KEY', env.vapidPublicKey, 'notificações push desativadas'],
    ['GMAIL_USER', env.gmailUser, 'convites por e-mail não serão enviados'],
  ];
  for (const [nome, valor, consequencia] of opcionais) {
    if (!valor) console.warn(`⚠️  ${nome} ausente — ${consequencia}.`);
  }
}

module.exports = { env, checkEnv };
