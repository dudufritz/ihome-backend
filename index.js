/**
 * index.js — Ponto de entrada do servidor iHome.
 *
 * Responsabilidade única: ligar as peças na ordem certa e subir o servidor.
 * A lógica vive em src/, organizada em camadas:
 *
 *   src/config/      variáveis de ambiente e conexão com o banco
 *   src/db/          criação e evolução do esquema
 *   src/middleware/  autenticação (verificação do JWT)
 *   src/services/    regras de negócio e integrações (Tuya, IA, e-mail, push,
 *                    criptografia, auditoria, compartilhamento)
 *   src/routes/      endpoints HTTP, um arquivo por área
 *   src/jobs/        rotinas em segundo plano (monitor, agendamentos, expurgo)
 *
 * O New Relic precisa ser o PRIMEIRO require do processo: ele instrumenta os
 * módulos do Node por dentro, e só consegue fazer isso com o que for carregado
 * depois dele.
 */
if (process.env.NEW_RELIC_LICENSE_KEY) require('newrelic');

const { env, checkEnv } = require('./src/config/env');
const { pool } = require('./src/config/database');
const { initDB } = require('./src/db/schema');
const { app } = require('./src/app');
const { startBackgroundJobs } = require('./src/jobs');

// Serviços reexportados no final para manter compatibilidade com os testes,
// que importam estas funções diretamente de '../index'.
const { recordAudit, describeCommands, purgeAuditLog } = require('./src/services/audit.service');
const { tokenCache } = require('./src/services/tuya.service');

// Avisa no log sobre variáveis de ambiente ausentes (não derruba o processo).
checkEnv();

// Cria as tabelas que ainda não existirem. Em teste o banco é mockado.
if (!env.isTest) {
  initDB().catch((err) => console.error('❌ Erro ao iniciar banco:', err));
}

// Liga os temporizadores (monitor, agendamentos, retenção).
startBackgroundJobs();

/*
 * Só abrimos a porta quando este arquivo é executado diretamente
 * (`node index.js`). Quando ele é apenas importado — como fazem os testes —
 * o app existe mas nenhuma porta é ocupada.
 */
/* istanbul ignore next */
if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`🏠 iHome API rodando em http://localhost:${env.port}`);
  });
}

module.exports = { app, pool, tokenCache, recordAudit, describeCommands, purgeAuditLog };
