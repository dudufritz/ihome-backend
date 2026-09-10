/**
 * audit.test.js — Registro de auditoria
 * Cobre: gravacao em sucesso/erro/negado, regra de visibilidade,
 * filtros da rota /audit-log e o expurgo por retencao.
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => {
  // O mock precisa expor a mesma interface do Pool real: alem de query(),
  // o codigo de producao registra um listener de erro com pool.on('error').
  const Pool = jest.fn().mockImplementation(() => ({
    query: mockQuery,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');

let app, tokenCache, describeCommands, purgeAuditLog;
beforeAll(() => {
  const mod = require('../index');
  app = mod.app;
  tokenCache = mod.tokenCache;
  describeCommands = mod.describeCommands;
  purgeAuditLog = mod.purgeAuditLog;
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  axios.mockReset();
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  if (tokenCache) Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
  axios.get = jest.fn();
  axios.post = jest.fn();
});
afterAll(() => { jest.clearAllMocks(); });

const OWNER = 'dono@ihome.com';
const GUEST = 'convidado@ihome.com';

function tok(email = OWNER, sub = 'u1') {
  return jwt.sign({ email, sub }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

// Localiza a chamada de INSERT na tabela audit_log entre todas as queries feitas
function auditInserts() {
  return mockQuery.mock.calls.filter(c => /INSERT INTO audit_log/i.test(c[0]));
}

// Prepara os mocks para um comando Tuya bem-sucedido.
// A ORDEM importa: a rota busca o nome do dispositivo ANTES de resolver as
// credenciais, porque o nome tambem precisa constar no registro de uma
// tentativa negada — que acontece antes de qualquer chamada a Tuya.
function mockTuyaOk() {
  mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Lampada da Sala' }], rowCount: 1 }); // nome
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
    rowCount: 1,
  }); // getUserTuya
  axios.get.mockResolvedValueOnce({
    data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
  });
  axios.mockResolvedValueOnce({ data: { success: true, result: {} } });
}

// ── GRAVACAO ──────────────────────────────────────────────────
describe('Auditoria — gravacao no comando de dispositivo', () => {
  test('comando bem-sucedido grava linha com ator, casa, dispositivo e result=success', async () => {
    mockTuyaOk();
    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });

    expect(r.status).toBe(200);
    const inserts = auditInserts();
    expect(inserts).toHaveLength(1);

    const [, params] = inserts[0];
    expect(params[0]).toBe(OWNER);          // home_owner_email
    expect(params[1]).toBe(OWNER);          // actor_email
    expect(params[2]).toBe('device.command');
    expect(params[3]).toBe('dev-1');        // device_id
    expect(params[4]).toBe('Lampada da Sala');
    expect(params[6]).toBe('success');
    expect(JSON.parse(params[5]).summary).toBe('Ligou');
  });

  test('falha na Tuya grava result=error com a mensagem do erro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya sem config
    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: false }] });

    expect(r.status).toBe(500);
    const inserts = auditInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1][6]).toBe('error');
    expect(inserts[0][1][7]).toBeTruthy(); // error_message preenchido
  });

  test('falha na Tuya PRESERVA o nome do dispositivo no log', async () => {
    // Regressao encontrada rodando contra Postgres real: deviceName era
    // declarado dentro do try, entao o catch nao o enxergava e o registro
    // de erro saia sem o nome — justamente quando ele mais importa.
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Lampada da Sala' }], rowCount: 1 }); // nome
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
      rowCount: 1,
    }); // getUserTuya
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 't', expire_time: 7200 } },
    });
    axios.mockRejectedValueOnce(new Error('Tuya indisponivel')); // o comando falha

    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });

    expect(r.status).toBe(500);
    const [, params] = auditInserts()[0];
    expect(params[4]).toBe('Lampada da Sala'); // device_name preenchido
    expect(params[6]).toBe('error');
  });

  test('convidado sem compartilhamento grava result=denied na casa do dono', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });                        // home_shares vazio
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Portao' }], rowCount: 1 });      // nome
    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok(GUEST)}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: OWNER });

    expect(r.status).toBe(403);
    const inserts = auditInserts();
    expect(inserts).toHaveLength(1);
    const [, params] = inserts[0];
    expect(params[0]).toBe(OWNER);   // registrado na casa do dono
    expect(params[1]).toBe(GUEST);   // mas o ator foi o convidado
    expect(params[6]).toBe('denied');
    // Resumo e nome precisam constar tambem na negativa. Sem eles a tela
    // mostraria "Comando enviado" num dispositivo sem nome, e a busca
    // textual nao acharia o 403 — justamente o evento que responde
    // "quem tentou acionar o que".
    expect(JSON.parse(params[5]).summary).toBe('Ligou');
    expect(params[4]).toBe('Portao');
  });

  test('convidado com permissao apenas de visualizacao grava denied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'view' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nome
    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok(GUEST)}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: OWNER });

    expect(r.status).toBe(403);
    expect(auditInserts()[0][1][6]).toBe('denied');
    expect(auditInserts()[0][1][7]).toMatch(/visualiza/i);
  });

  test('convidado com permissao control registra a acao na casa do dono', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'control' }], rowCount: 1 });
    mockTuyaOk();
    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok(GUEST)}`)
      .send({ commands: [{ code: 'switch_1', value: false }], owner_email: OWNER });

    expect(r.status).toBe(200);
    const [, params] = auditInserts()[0];
    expect(params[0]).toBe(OWNER);
    expect(params[1]).toBe(GUEST);
    expect(params[6]).toBe('success');
    expect(JSON.parse(params[5]).summary).toBe('Desligou');
  });

  test('falha ao gravar auditoria nao derruba a resposta da acao', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Portao' }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
      rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 't', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { success: true, result: {} } });
    mockQuery.mockRejectedValueOnce(new Error('banco fora do ar')); // o INSERT falha

    const r = await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });

    expect(r.status).toBe(200); // acao segue valida mesmo sem log
  });

  test('registra o IP real vindo do X-Forwarded-For', async () => {
    mockTuyaOk();
    await request(app).post('/devices/dev-1/command')
      .set('Authorization', `Bearer ${tok()}`)
      .set('X-Forwarded-For', '203.0.113.10, 10.0.0.1')
      .send({ commands: [{ code: 'switch_1', value: true }] });

    expect(auditInserts()[0][1][8]).toBe('203.0.113.10');
  });
});

// ── DESCRICAO DOS COMANDOS ────────────────────────────────────
describe('describeCommands', () => {
  test('traduz switch_1 para Ligou / Desligou', () => {
    expect(describeCommands([{ code: 'switch_1', value: true }])).toBe('Ligou');
    expect(describeCommands([{ code: 'switch_1', value: false }])).toBe('Desligou');
  });
  test('lista codigos desconhecidos com o valor', () => {
    expect(describeCommands([{ code: 'temp_set', value: 22 }])).toBe('temp_set = 22');
  });
  test('entrada vazia ou invalida cai no texto padrao', () => {
    expect(describeCommands([])).toBe('Comando enviado');
    expect(describeCommands(null)).toBe('Comando enviado');
  });
});

// ── CONSULTA ──────────────────────────────────────────────────
describe('GET /audit-log', () => {
  test('sem token => 401', async () => {
    const r = await request(app).get('/audit-log');
    expect(r.status).toBe(401);
  });

  test('retorna total, paginacao e entradas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: 2 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 2, actor_email: OWNER, action: 'device.command', result: 'success' },
        { id: 1, actor_email: GUEST, action: 'device.command', result: 'denied' },
      ],
      rowCount: 2,
    });
    const r = await request(app).get('/audit-log').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.entries).toHaveLength(2);
    expect(r.body.limit).toBe(100);
    expect(r.body.offset).toBe(0);
  });

  test('escopo limita a casas proprias ou acoes proprias', async () => {
    await request(app).get('/audit-log').set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).toMatch(/home_owner_email = \$1 OR actor_email = \$1/);
    expect(sel[1][0]).toBe(OWNER);
  });

  test('filtro por ator entra na consulta', async () => {
    await request(app).get(`/audit-log?actor=${encodeURIComponent(GUEST)}`)
      .set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).toMatch(/actor_email = \$2/);
    expect(sel[1]).toContain(GUEST);
  });

  test('filtro de resultado invalido e ignorado', async () => {
    await request(app).get('/audit-log?result=qualquer-coisa')
      .set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).not.toMatch(/result = \$/);
  });

  test('filtro de resultado valido e aplicado', async () => {
    await request(app).get('/audit-log?result=denied')
      .set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).toMatch(/result = \$2/);
    expect(sel[1]).toContain('denied');
  });

  test('periodo de e ate viram filtros de data', async () => {
    await request(app).get('/audit-log?from=2026-01-01&to=2026-01-31')
      .set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).toMatch(/created_at >= /);
    expect(sel[0]).toMatch(/INTERVAL '1 day'/);
  });

  test('busca textual usa ILIKE com curinga', async () => {
    await request(app).get('/audit-log?q=sala').set('Authorization', `Bearer ${tok()}`);
    const sel = mockQuery.mock.calls.find(c => /FROM audit_log/i.test(c[0]));
    expect(sel[0]).toMatch(/ILIKE/);
    expect(sel[1]).toContain('%sala%');
  });

  test('limit e limitado a 500', async () => {
    const r = await request(app).get('/audit-log?limit=99999')
      .set('Authorization', `Bearer ${tok()}`);
    expect(r.body.limit).toBe(500);
  });

  test('offset negativo vira zero', async () => {
    const r = await request(app).get('/audit-log?offset=-50')
      .set('Authorization', `Bearer ${tok()}`);
    expect(r.body.offset).toBe(0);
  });

  test('erro no banco retorna 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('falha de conexao'));
    const r = await request(app).get('/audit-log').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });
});

describe('GET /audit-log/actors', () => {
  test('sem token => 401', async () => {
    const r = await request(app).get('/audit-log/actors');
    expect(r.status).toBe(401);
  });

  test('retorna lista simples de e-mails', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ actor_email: OWNER }, { actor_email: GUEST }],
      rowCount: 2,
    });
    const r = await request(app).get('/audit-log/actors').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([OWNER, GUEST]);
  });

  test('erro no banco retorna 500', async () => {
    mockQuery.mockRejectedValueOnce(new Error('falha'));
    const r = await request(app).get('/audit-log/actors').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });
});

// ── RETENCAO ──────────────────────────────────────────────────
describe('purgeAuditLog', () => {
  test('apaga registros acima do periodo de retencao', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 7 });
    await purgeAuditLog();
    const del = mockQuery.mock.calls.find(c => /DELETE FROM audit_log/i.test(c[0]));
    expect(del).toBeDefined();
    expect(del[1]).toEqual(['90']);
  });

  test('erro no expurgo nao propaga excecao', async () => {
    mockQuery.mockRejectedValueOnce(new Error('sem conexao'));
    await expect(purgeAuditLog()).resolves.toBeUndefined();
  });
});
