/**
 * auth-flow.test.js — Autenticacao propria do iHome.
 *
 * Cobre o ciclo completo: cadastro, login, rotacao de refresh token,
 * deteccao de reuso, redefinicao de senha e confirmacao de e-mail.
 */
process.env.JWT_SECRET = 'segredo-de-teste-nao-usar-em-producao';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
// bcrypt com custo baixo: 12 rounds deixaria a suite lenta sem ganho de teste.
process.env.BCRYPT_ROUNDS = '4';

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

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let app, authService;
beforeAll(() => {
  app = require('../index').app;
  authService = require('../src/services/auth.service');
});

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockSendMail.mockClear();
});

/** Usuario ficticio com senha "senha-valida-123" ja hasheada. */
function usuarioFake(overrides = {}) {
  return {
    id: 1,
    email: 'eduardo@ihome.com',
    password_hash: require('bcryptjs').hashSync('senha-valida-123', 4),
    full_name: 'Eduardo Fritz',
    email_verified: false,
    ...overrides,
  };
}

function acharQuery(regex) {
  return mockQuery.mock.calls.find((c) => regex.test(c[0]));
}

// ═══════════════════════════════════════════════════════════════
// CADASTRO
// ═══════════════════════════════════════════════════════════════
describe('POST /auth/register', () => {
  test('cria conta, devolve tokens e nao expoe o hash da senha', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });              // e-mail livre
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 }); // INSERT

    const r = await request(app).post('/auth/register').send({
      email: 'Eduardo@iHome.com', password: 'senha-valida-123',
      full_name: 'Eduardo Fritz', cpf: '123.456.789-00', phone: '(47) 99999-8888',
    });

    expect(r.status).toBe(201);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toBeTruthy();
    expect(r.body.user.email).toBe('eduardo@ihome.com'); // normalizado
    expect(r.body.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(r.body)).not.toContain('password_hash');
  });

  test('grava apenas os digitos de CPF e telefone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });

    await request(app).post('/auth/register').send({
      email: 'a@b.com', password: 'senha-valida-123',
      cpf: '123.456.789-00', phone: '(47) 99999-8888',
    });

    const insert = acharQuery(/INSERT INTO users/i);
    expect(insert[1]).toContain('12345678900');
    expect(insert[1]).toContain('47999998888');
  });

  test('a senha nunca vai para o banco em texto puro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });

    await request(app).post('/auth/register')
      .send({ email: 'a@b.com', password: 'senha-valida-123' });

    const insert = acharQuery(/INSERT INTO users/i);
    expect(insert[1]).not.toContain('senha-valida-123');
    expect(insert[1][1]).toMatch(/^\$2[aby]\$/); // formato do hash bcrypt
  });

  test('e-mail ja cadastrado retorna 409', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const r = await request(app).post('/auth/register')
      .send({ email: 'eduardo@ihome.com', password: 'senha-valida-123' });
    expect(r.status).toBe(409);
  });

  test('e-mail invalido retorna 400', async () => {
    const r = await request(app).post('/auth/register')
      .send({ email: 'nao-e-email', password: 'senha-valida-123' });
    expect(r.status).toBe(400);
  });

  test('senha curta retorna 400 sem tocar no banco', async () => {
    const r = await request(app).post('/auth/register')
      .send({ email: 'a@b.com', password: '123' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/8 caracteres/);
    expect(acharQuery(/INSERT INTO users/i)).toBeUndefined();
  });

  test('dispara o e-mail de confirmacao', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });

    await request(app).post('/auth/register')
      .send({ email: 'a@b.com', password: 'senha-valida-123' });

    expect(mockSendMail).toHaveBeenCalled();
    expect(mockSendMail.mock.calls[0][0].subject).toMatch(/[Cc]onfirme/);
  });

  test('falha no envio do e-mail nao desfaz o cadastro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    mockSendMail.mockRejectedValueOnce(new Error('SMTP fora do ar'));

    const r = await request(app).post('/auth/register')
      .send({ email: 'a@b.com', password: 'senha-valida-123' });
    expect(r.status).toBe(201); // a conta existe mesmo assim
  });
});

// ═══════════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════════
describe('POST /auth/login', () => {
  test('credenciais corretas devolvem token utilizavel', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });

    const r = await request(app).post('/auth/login')
      .send({ email: 'eduardo@ihome.com', password: 'senha-valida-123' });

    expect(r.status).toBe(200);
    const decoded = jwt.verify(r.body.access_token, process.env.JWT_SECRET);
    expect(decoded.email).toBe('eduardo@ihome.com');
    expect(decoded.sub).toBe('1');
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('senha errada retorna 401', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const r = await request(app).post('/auth/login')
      .send({ email: 'eduardo@ihome.com', password: 'senha-errada' });
    expect(r.status).toBe(401);
  });

  test('e-mail inexistente e senha errada dao a MESMA resposta', async () => {
    // Nao vazar quais e-mails tem conta: as duas falhas sao indistinguiveis.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const inexistente = await request(app).post('/auth/login')
      .send({ email: 'ninguem@ihome.com', password: 'qualquer-senha' });

    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const senhaErrada = await request(app).post('/auth/login')
      .send({ email: 'eduardo@ihome.com', password: 'senha-errada' });

    expect(inexistente.status).toBe(senhaErrada.status);
    expect(inexistente.body.error).toBe(senhaErrada.body.error);
  });

  test('login e case-insensitive no e-mail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const r = await request(app).post('/auth/login')
      .send({ email: '  EDUARDO@IHOME.COM  ', password: 'senha-valida-123' });

    expect(r.status).toBe(200);
    expect(acharQuery(/SELECT \* FROM users WHERE email/i)[1][0]).toBe('eduardo@ihome.com');
  });

  test('o refresh token e gravado como hash, nunca em texto puro', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const r = await request(app).post('/auth/login')
      .send({ email: 'eduardo@ihome.com', password: 'senha-valida-123' });

    const insert = acharQuery(/INSERT INTO refresh_tokens/i);
    const gravado = insert[1][1];
    expect(gravado).not.toBe(r.body.refresh_token);
    expect(gravado).toBe(
      crypto.createHash('sha256').update(r.body.refresh_token).digest('hex')
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// REFRESH E ROTACAO
// ═══════════════════════════════════════════════════════════════
describe('POST /auth/refresh', () => {
  const linhaValida = () => ({
    id: 10, user_id: 1, email: 'eduardo@ihome.com', full_name: 'Eduardo',
    expires_at: new Date(Date.now() + 86400000),
    revoked_at: null,
  });

  test('token valido e trocado por um par novo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linhaValida()], rowCount: 1 });

    const r = await request(app).post('/auth/refresh').send({ refresh_token: 'abc' });

    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.refresh_token).toBeTruthy();
    expect(r.body.refresh_token).not.toBe('abc'); // rotacionou
  });

  test('o token antigo e queimado na rotacao', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linhaValida()], rowCount: 1 });
    await request(app).post('/auth/refresh').send({ refresh_token: 'abc' });

    const update = acharQuery(/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE id/i);
    expect(update).toBeDefined();
    expect(update[1]).toEqual([10]);
  });

  test('reuso de token ja queimado derruba TODAS as sessoes', async () => {
    // Cenario de roubo: o ladrao usou o token, o dono tenta usar o mesmo.
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...linhaValida(), revoked_at: new Date() }], rowCount: 1,
    });

    const r = await request(app).post('/auth/refresh').send({ refresh_token: 'roubado' });

    expect(r.status).toBe(401);
    const revogaTudo = acharQuery(/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE user_id/i);
    expect(revogaTudo).toBeDefined();
    expect(revogaTudo[1]).toEqual([1]);
  });

  test('token expirado retorna 401 sem rotacionar', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...linhaValida(), expires_at: new Date(Date.now() - 1000) }], rowCount: 1,
    });
    const r = await request(app).post('/auth/refresh').send({ refresh_token: 'velho' });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/expirada/i);
  });

  test('token desconhecido retorna 401', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).post('/auth/refresh').send({ refresh_token: 'inventado' });
    expect(r.status).toBe(401);
  });

  test('sem refresh token retorna 401', async () => {
    const r = await request(app).post('/auth/refresh').send({});
    expect(r.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// LOGOUT
// ═══════════════════════════════════════════════════════════════
describe('POST /auth/logout', () => {
  test('revoga apenas o token enviado', async () => {
    const r = await request(app).post('/auth/logout').send({ refresh_token: 'meu-token' });
    expect(r.status).toBe(200);
    const update = acharQuery(/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE token_hash/i);
    expect(update).toBeDefined();
  });

  test('logout sem token nao quebra', async () => {
    const r = await request(app).post('/auth/logout').send({});
    expect(r.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
// REDEFINICAO DE SENHA
// ═══════════════════════════════════════════════════════════════
describe('Redefinicao de senha', () => {
  test('forgot-password responde 200 mesmo para e-mail inexistente', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).post('/auth/forgot-password')
      .send({ email: 'ninguem@ihome.com' });

    expect(r.status).toBe(200);          // nao revela que a conta nao existe
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('forgot-password de conta existente envia o e-mail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const r = await request(app).post('/auth/forgot-password')
      .send({ email: 'eduardo@ihome.com' });

    expect(r.status).toBe(200);
    expect(mockSendMail).toHaveBeenCalled();
    expect(mockSendMail.mock.calls[0][0].subject).toMatch(/[Rr]edefini/);
  });

  test('as duas respostas de forgot-password sao identicas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const semConta = await request(app).post('/auth/forgot-password').send({ email: 'x@y.com' });
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });
    const comConta = await request(app).post('/auth/forgot-password').send({ email: 'eduardo@ihome.com' });

    expect(semConta.body).toEqual(comConta.body);
  });

  test('reset com token valido troca a senha e derruba as sessoes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 1 }], rowCount: 1 }); // consome token

    const r = await request(app).post('/auth/reset-password')
      .send({ token: 'token-do-email', password: 'nova-senha-forte' });

    expect(r.status).toBe(200);
    const update = acharQuery(/UPDATE users SET password_hash/i);
    expect(update[1][0]).toMatch(/^\$2[aby]\$/);      // gravou hash, nao a senha
    expect(update[1][0]).not.toContain('nova-senha-forte');
    // Se a conta estava comprometida, as sessoes antigas precisam cair junto.
    expect(acharQuery(/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE user_id/i)).toBeDefined();
  });

  test('reset com token invalido ou expirado retorna 400', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).post('/auth/reset-password')
      .send({ token: 'expirado', password: 'nova-senha-forte' });
    expect(r.status).toBe(400);
  });

  test('reset com senha fraca retorna 400 antes de consumir o token', async () => {
    const r = await request(app).post('/auth/reset-password')
      .send({ token: 'qualquer', password: '123' });
    expect(r.status).toBe(400);
    expect(acharQuery(/UPDATE auth_tokens/i)).toBeUndefined();
  });

  test('o consumo do token e atomico (valida e marca usado numa query so)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 1 }], rowCount: 1 });
    await request(app).post('/auth/reset-password')
      .send({ token: 't', password: 'nova-senha-forte' });

    const consumo = acharQuery(/UPDATE auth_tokens SET used_at/i);
    // As tres condicoes na mesma instrucao impedem uso duplo sob concorrencia.
    expect(consumo[0]).toMatch(/used_at IS NULL/);
    expect(consumo[0]).toMatch(/expires_at > NOW\(\)/);
    expect(consumo[0]).toMatch(/RETURNING user_id/);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONFIRMACAO DE E-MAIL
// ═══════════════════════════════════════════════════════════════
describe('GET /auth/verify-email/:token', () => {
  test('token valido marca o e-mail como verificado e redireciona', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ user_id: 1 }], rowCount: 1 });
    const r = await request(app).get('/auth/verify-email/token-bom');

    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/verify=success/);
    expect(acharQuery(/UPDATE users SET email_verified = true/i)).toBeDefined();
  });

  test('token invalido redireciona com aviso', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).get('/auth/verify-email/token-ruim');
    expect(r.headers.location).toMatch(/verify=invalid/);
  });
});

// ═══════════════════════════════════════════════════════════════
// SESSAO ATUAL
// ═══════════════════════════════════════════════════════════════
describe('GET /auth/me', () => {
  test('sem token retorna 401', async () => {
    const r = await request(app).get('/auth/me');
    expect(r.status).toBe(401);
  });

  test('com token valido devolve o usuario sem o hash da senha', async () => {
    const token = jwt.sign(
      { sub: '1', email: 'eduardo@ihome.com' },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' }
    );
    mockQuery.mockResolvedValueOnce({ rows: [usuarioFake()], rowCount: 1 });

    const r = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('eduardo@ihome.com');
    expect(r.body.user).not.toHaveProperty('password_hash');
  });

  test('token expirado retorna 401 com code token_expired', async () => {
    const token = jwt.sign(
      { sub: '1', email: 'eduardo@ihome.com' },
      process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1s' }
    );
    const r = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);

    expect(r.status).toBe(401);
    // O frontend usa este code para decidir entre renovar o token ou pedir login.
    expect(r.body.code).toBe('token_expired');
  });

  test('token assinado com outro segredo e recusado', async () => {
    const token = jwt.sign({ sub: '1', email: 'x@y.com' }, 'segredo-errado');
    const r = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIDADE — auth.service
// ═══════════════════════════════════════════════════════════════
describe('auth.service — funcoes puras', () => {
  test('hash da senha nunca e igual a senha e confere na verificacao', async () => {
    const hash = await authService.hashPassword('minha-senha');
    expect(hash).not.toBe('minha-senha');
    expect(await authService.verifyPassword('minha-senha', hash)).toBe(true);
    expect(await authService.verifyPassword('outra-senha', hash)).toBe(false);
  });

  test('a mesma senha gera hashes diferentes (salt aleatorio)', async () => {
    const a = await authService.hashPassword('igual');
    const b = await authService.hashPassword('igual');
    expect(a).not.toBe(b);
  });

  test('verificar senha contra hash ausente nao lanca e retorna false', async () => {
    // Caminho do usuario inexistente: compara com o hash ficticio.
    expect(await authService.verifyPassword('qualquer', undefined)).toBe(false);
  });

  test('validarSenha aplica o minimo de 8 caracteres', () => {
    expect(authService.validarSenha('1234567')).toMatch(/8 caracteres/);
    expect(authService.validarSenha('12345678')).toBeNull();
    expect(authService.validarSenha(null)).toBeTruthy();
    expect(authService.validarSenha('x'.repeat(201))).toMatch(/longa/);
  });

  test('token opaco tem 256 bits e nunca se repete', () => {
    const a = authService.gerarTokenOpaco();
    const b = authService.gerarTokenOpaco();
    expect(a).toHaveLength(64); // 32 bytes em hexadecimal
    expect(a).not.toBe(b);
  });

  test('usuarioPublico remove o hash da senha', () => {
    const publico = authService.usuarioPublico(usuarioFake());
    expect(publico).not.toHaveProperty('password_hash');
    expect(publico).not.toHaveProperty('cpf'); // CPF tambem nao volta para o cliente
    expect(publico.email).toBe('eduardo@ihome.com');
  });

  test('usuarioPublico lida com entrada nula', () => {
    expect(authService.usuarioPublico(null)).toBeNull();
  });
});
