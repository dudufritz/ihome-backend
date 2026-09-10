/**
 * config/database.js — Conexão com o PostgreSQL.
 *
 * Usamos um Pool, e não uma conexão única, porque o Node atende várias
 * requisições ao mesmo tempo: o Pool mantém um conjunto de conexões prontas
 * e as empresta conforme a demanda, evitando o custo de abrir uma conexão
 * TCP+TLS nova a cada query.
 */
const { Pool } = require('pg');
const { env } = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  // SSL só em produção: o Postgres do docker-compose local não fala TLS,
  // e exigir conexão cifrada ali faria o servidor nem subir.
  //
  // Em produção, o Azure Database for PostgreSQL apresenta certificado
  // próprio. rejectUnauthorized:false o aceita sem exigir a CA local.
  // ⚠️ Isto desativa a validação da cadeia: protege contra escuta passiva,
  // mas não contra um intermediário ativo. Ver ARQUITETURA.md §12.
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,                      // no máximo 10 conexões simultâneas
  idleTimeoutMillis: 30000,     // devolve ao SO conexões ociosas há 30s
  connectionTimeoutMillis: 10000, // desiste de conectar após 10s
});

// Um erro em conexão ociosa não deve derrubar o processo inteiro.
pool.on('error', (err) => {
  console.error('❌ Erro inesperado em conexão ociosa do pool:', err.message);
});

module.exports = { pool };
