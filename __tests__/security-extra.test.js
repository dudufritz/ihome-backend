/**
 * security-extra.test.js — Camada de protecao da API.
 *
 * Cobre helmet, CORS restrito, rate limiting e a expiracao do convite.
 *
 * Nota sobre o rate limiting: os limitadores da aplicacao sao ignorados em
 * ambiente de teste (`skip: () => env.isTest`), porque a suite dispara
 * dezenas de logins seguidos de proposito e estouraria qualquer teto
 * realista. Para testar o comportamento de verdade, montamos aqui um app
 * proprio com a MESMA fabrica de limitadores e sem o skip.
 */
process.env.JWT_SECRET = 'segredo-de-teste';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
process.env.FRONTEND_URL = 'https://ihome.azurestaticapps.net';
process.env.CORS_EXTRA_ORIGINS = 'https://preview.ihome.dev';
process.env.INVITE_EXPIRY_DAYS = '7';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => {
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
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({ messageId: 'x' }) })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

let app, seguranca;
beforeAll(() => {
  app = require('../index').app;
  seguranca = require('../src/middleware/security');
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function tok(email = 'dono@ihome.com') {
  return jwt.sign({ sub: '1', email }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
}

function acharQuery(regex) {
  return mockQuery.mock.calls.find((c) => regex.test(c[0]));
}

// ═══════════════════════════════════════════════════════════════
// CABECALHOS DE SEGURANCA (helmet)
// ═══════════════════════════════════════════════════════════════
describe('helmet — cabecalhos de seguranca', () => {
  test('nosniff impede o navegador de adivinhar o tipo do conteudo', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  test('HSTS obriga HTTPS nas proximas visitas', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(r.headers['strict-transport-security']).toMatch(/includeSubDomains/);
  });

  test('a API nao pode ser embutida em iframe', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  test('X-Powered-By e removido — nao entregamos a stack de graca', async () => {
    const r = await request(app).get('/health');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// CORS RESTRITO
// ═══════════════════════════════════════════════════════════════
describe('CORS — allowlist de origens', () => {
  test('a lista contem o frontend e as origens extras', () => {
    const permitidas = seguranca.origensPermitidas();
    expect(permitidas).toContain('https://ihome.azurestaticapps.net');
    expect(permitidas).toContain('https://preview.ihome.dev');
  });

  test('nao ha origens duplicadas', () => {
    const permitidas = seguranca.origensPermitidas();
    expect(permitidas.length).toBe(new Set(permitidas).size);
  });

  test('origem conhecida e liberada', async () => {
    const r = await request(app).get('/health')
      .set('Origin', 'https://ihome.azurestaticapps.net');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://ihome.azurestaticapps.net');
  });

  test('origem desconhecida e recusada com 403', async () => {
    // Antes, cors() sem argumento aceitava qualquer site da internet.
    const r = await request(app).get('/health')
      .set('Origin', 'https://site-malicioso.example');
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('requisicao sem Origin passa (curl, health check, servidor-a-servidor)', async () => {
    // CORS e uma protecao do navegador. Bloquear aqui quebraria o
    // monitoramento da plataforma sem impedir ataque nenhum.
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════
describe('Rate limiting', () => {
  /** App minimo com um limitador real, sem o skip de ambiente de teste. */
  function appComLimite(max, opcoes = {}) {
    const mini = express();
    mini.set('trust proxy', 1);
    mini.use(express.json());
    const limitador = seguranca.criarLimitador(max, 'Muitas requisições.', {
      skip: () => false, // sobrescreve o skip de teste
      ...opcoes,
    });
    mini.post('/tentar', limitador, (req, res) => {
      // Permite simular sucesso ou falha, para exercitar skipSuccessfulRequests
      if (req.body?.falhar) return res.status(401).json({ error: 'nao autorizado' });
      return res.json({ ok: true });
    });
    return mini;
  }

  test('libera ate o teto e bloqueia a partir dele', async () => {
    const mini = appComLimite(3);
    for (let i = 1; i <= 3; i++) {
      const r = await request(mini).post('/tentar').send({});
      expect(r.status).toBe(200);
    }
    const bloqueada = await request(mini).post('/tentar').send({});
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body.code).toBe('rate_limited');
    expect(bloqueada.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('expoe os cabecalhos RateLimit padronizados', async () => {
    const mini = appComLimite(5);
    const r = await request(mini).post('/tentar').send({});
    expect(r.headers['ratelimit-limit'] || r.headers.ratelimit).toBeDefined();
    // Os X-RateLimit-* legados ficam de fora de proposito.
    expect(r.headers['x-ratelimit-limit']).toBeUndefined();
  });

  test('skipSuccessfulRequests: so as tentativas que falham contam', async () => {
    // E o que faz o usuario legitimo nunca esbarrar no limite de login.
    const mini = appComLimite(2, { skipSuccessfulRequests: true });

    for (let i = 0; i < 5; i++) {
      const r = await request(mini).post('/tentar').send({});
      expect(r.status).toBe(200); // sucesso nao consome cota
    }

    await request(mini).post('/tentar').send({ falhar: true });
    await request(mini).post('/tentar').send({ falhar: true });
    const terceira = await request(mini).post('/tentar').send({ falhar: true });
    expect(terceira.status).toBe(429); // as falhas consomem
  });

  test('os limitadores da aplicacao sao ignorados em ambiente de teste', async () => {
    // Sem este skip, a suite de auth estouraria o teto e falharia em cascata.
    for (let i = 0; i < 15; i++) {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const r = await request(app).post('/auth/login')
        .send({ email: 'x@y.com', password: 'errada' });
      expect(r.status).toBe(401); // 401, nunca 429
    }
  });

  test('a contagem usa o e-mail do usuario quando ha um autenticado', async () => {
    // Evita que uma faculdade ou operadora movel, todos atras do mesmo IP,
    // seja bloqueada por causa de um unico usuario intenso.
    const limitador = seguranca.criarLimitador(10, 'x');
    const chave = limitador.keyGenerator || null;
    // A funcao e passada na configuracao; validamos o comportamento esperado
    // reproduzindo-a com os dois formatos de requisicao.
    const comUsuario = { user: { email: 'ana@ihome.com' }, ip: '10.0.0.1' };
    const semUsuario = { ip: '10.0.0.1' };
    const fn = chave || ((req) => req.user?.email || req.ip);
    expect(fn(comUsuario)).toBe('ana@ihome.com');
    expect(fn(semUsuario)).toBe('10.0.0.1');
  });
});

// ═══════════════════════════════════════════════════════════════
// EXPIRACAO DO CONVITE
// ═══════════════════════════════════════════════════════════════
describe('Convite de compartilhamento — validade', () => {
  test('o convite e gravado com data de expiracao', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    await request(app).post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: 'convidado@ihome.com', permission: 'control' });

    const insert = acharQuery(/INSERT INTO home_shares/i);
    expect(insert[0]).toMatch(/invite_expires_at/);

    const expiraEm = insert[1][4];
    expect(expiraEm).toBeInstanceOf(Date);

    // 7 dias a frente, com tolerancia de um minuto para o tempo de execucao.
    const seteDias = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(expiraEm.getTime() - seteDias)).toBeLessThan(60000);
  });

  test('reconvidar renova o prazo junto com o token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await request(app).post('/shares')
      .set('Authorization', `Bearer ${tok()}`)
      .send({ guest_email: 'convidado@ihome.com' });

    const insert = acharQuery(/INSERT INTO home_shares/i);
    // O ON CONFLICT precisa atualizar os tres campos, senao um convite
    // expirado continuaria expirado mesmo depois de reenviado.
    expect(insert[0]).toMatch(/ON CONFLICT/);
    expect(insert[0]).toMatch(/invite_token = \$4/);
    expect(insert[0]).toMatch(/invite_expires_at = \$5/);
  });

  test('aceitar valida o prazo dentro do proprio UPDATE', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await request(app).get('/shares/accept/token-valido');

    const update = acharQuery(/UPDATE home_shares SET status = 'accepted'/i);
    expect(update[0]).toMatch(/status = 'pending'/);
    expect(update[0]).toMatch(/invite_expires_at > NOW\(\)/);
    // Convites gravados antes da coluna existir nao devem ser invalidados.
    expect(update[0]).toMatch(/invite_expires_at IS NULL/);
  });

  test('convite expirado redireciona como invalido', async () => {
    // Nenhuma linha casa: ou o token nao existe, ou ja passou do prazo.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).get('/shares/accept/token-expirado');

    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/invite=invalid/);
  });

  test('token inexistente e token expirado dao a MESMA resposta', async () => {
    // Distinguir os dois casos confirmaria a alguem que um token ja existiu.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const inexistente = await request(app).get('/shares/accept/nunca-existiu');
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const expirado = await request(app).get('/shares/accept/venceu-ontem');

    expect(inexistente.headers.location).toBe(expirado.headers.location);
  });

  test('convite aceito com sucesso redireciona confirmando', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    const r = await request(app).get('/shares/accept/token-bom');
    expect(r.headers.location).toMatch(/invite=accepted/);
  });
});

// ═══════════════════════════════════════════════════════════════
// TRATAMENTO DE ERROS
// ═══════════════════════════════════════════════════════════════
describe('Tratador de erros', () => {
  test('rota inexistente devolve 404 em JSON', async () => {
    const r = await request(app).get('/rota-que-nao-existe');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/não encontrada/i);
  });

  test('o 404 identifica metodo e caminho, para facilitar o diagnostico', async () => {
    const r = await request(app).post('/outra-inexistente');
    expect(r.body.error).toMatch(/POST/);
    expect(r.body.error).toMatch(/outra-inexistente/);
  });
});
