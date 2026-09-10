/**
 * db/schema.js — Criação e evolução do esquema do banco.
 *
 * Estratégia: "migração na subida". Toda instrução usa IF NOT EXISTS, então
 * rodar initDB() várias vezes é seguro (é uma operação idempotente). Isso
 * dispensa uma ferramenta de migração externa num projeto deste porte, ao
 * custo de não haver rollback — aceitável porque só adicionamos estruturas.
 */
const { pool } = require('../config/database');

async function initDB() {
  // ═══════════════════════════════════════════════════════════
  //  AUTENTICAÇÃO PRÓPRIA
  //  O iHome emite e valida os próprios tokens. Não há provedor
  //  de identidade externo: o e-mail continua sendo a chave que
  //  liga usuário, dispositivos e compartilhamentos.
  // ═══════════════════════════════════════════════════════════

  // Contas de usuário.
  // password_hash guarda o resultado do bcrypt, nunca a senha.
  // O hash do bcrypt já embute o salt, por isso não há coluna separada.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      cpf TEXT,
      phone TEXT,
      email_verified BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Refresh tokens.
  //
  // Guardamos apenas o SHA-256 do token, nunca o valor original: se o banco
  // vazar, os tokens capturados não servem para autenticar. É o mesmo
  // princípio da senha, com hash rápido porque o token já tem 256 bits de
  // entropia e não precisa de proteção contra força bruta.
  //
  // revoked_at != NULL marca o token como queimado. Não apagamos a linha
  // porque a presença dela é o que permite detectar REUSO: um refresh token
  // já rotacionado sendo apresentado de novo indica que alguém o roubou.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id)`);

  // Tokens de uso único para redefinir senha e confirmar e-mail.
  // A coluna purpose distingue os dois casos numa tabela só — a estrutura
  // é idêntica e separar em duas tabelas duplicaria a lógica de expiração.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      purpose TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose)`);

  // ── Credenciais da conta Tuya de cada usuário ──
  // tuya_secret é gravado cifrado (ver services/crypto.service.js).
  // UNIQUE(user_email) garante uma configuração por usuário e viabiliza o
  // ON CONFLICT DO UPDATE usado no cadastro.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_tuya_config (
      id SERIAL PRIMARY KEY,
      user_email TEXT UNIQUE NOT NULL,
      tuya_access_id TEXT NOT NULL,
      tuya_secret TEXT NOT NULL,
      tuya_base_url TEXT NOT NULL DEFAULT 'https://openapi.tuyaus.com',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Dispositivos que o usuário escolheu trazer da Tuya para o iHome ──
  // user_email é o eixo do isolamento multi-inquilino: toda consulta filtra
  // por ele, então um usuário nunca enxerga linha de outro.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      tuya_id TEXT NOT NULL,
      name TEXT NOT NULL,
      room TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Agendamentos (rotinas por horário) ──
  // on_time/off_time são TEXT no formato "HH:MM" porque a comparação é feita
  // contra o relógio do servidor formatado da mesma maneira, uma vez por minuto.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_schedules (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      on_time TEXT,
      off_time TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Alertas de conectividade gerados pelo monitor ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_alerts (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Último estado conhecido de cada dispositivo ──
  // Serve para detectar TRANSIÇÃO (ficou offline / voltou), e não estado:
  // sem esta tabela o monitor alertaria a cada 5 minutos enquanto o
  // dispositivo estivesse fora do ar.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_status_cache (
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      online BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_email, device_id)
    )
  `);

  // ── Compartilhamento de casa ──
  // status: 'pending' → convite enviado e ainda não respondido
  //         'accepted' → convidado aceitou e passa a ter acesso
  // UNIQUE(owner_email, guest_email) impede convites duplicados e permite
  // reenviar o convite com ON CONFLICT DO UPDATE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS home_shares (
      id SERIAL PRIMARY KEY,
      owner_email TEXT NOT NULL,
      guest_email TEXT NOT NULL,
      permission TEXT NOT NULL DEFAULT 'control',
      status TEXT NOT NULL DEFAULT 'pending',
      invite_token TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(owner_email, guest_email)
    )
  `);
  // Migrações para bases criadas antes destas colunas existirem
  await pool.query(`ALTER TABLE home_shares ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE home_shares ADD COLUMN IF NOT EXISTS invite_token TEXT`);
  // Validade do convite. Sem ela, um token gerado hoje continuaria aceitável
  // daqui a dois anos — inclusive se o e-mail tivesse vazado nesse meio-tempo.
  await pool.query(`ALTER TABLE home_shares ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ`);

  // ── Assinaturas de notificação push ──
  // Uma linha por navegador/dispositivo: o mesmo usuário no celular e no
  // desktop gera duas assinaturas distintas.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ── Registro de auditoria ──
  // home_owner_email e actor_email são propositalmente separados: a linha é
  // gravada na CASA onde a ação ocorreu, mas guarda QUEM a executou. É essa
  // separação que permite ao dono ver o que um convidado fez na casa dele.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      home_owner_email TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      device_id TEXT,
      device_name TEXT,
      details JSONB,
      result TEXT NOT NULL DEFAULT 'success',
      error_message TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Índices que sustentam as duas consultas da tela de auditoria.
  // A ordem das colunas importa: filtra-se pelo e-mail e ordena-se por data,
  // então o índice composto atende filtro e ordenação numa única varredura.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_home  ON audit_log (home_owner_email, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_email, created_at DESC)`);

  console.log('✅ Banco de dados iniciado!');
}

module.exports = { initDB };
