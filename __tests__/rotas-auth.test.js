/**
 * rotas-auth.test.js — Autenticação e rotas públicas.
 *
 * Testes de integração com o app Express real (supertest), banco e rede
 * mockados. Separado de `routes.test.js`, que reunia 29 blocos de domínios
 * diferentes em 741 linhas, a pedido do @pdrollucas no review do PR #1.
 *
 * O ambiente compartilhado — variáveis, mocks e ganchos — está em
 * `helpers/ambiente-rotas.js`.
 */
const request = require('supertest');
const { ctx, prepararAmbiente, tok, mockQuery } = require('./helpers/ambiente-rotas');

prepararAmbiente();

describe('Publicas', () => {
  test('GET / ok', async () => {
    const r = await request(ctx.app).get('/');
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/iHome/i);
  });
  test('GET /health ok:true push presente', async () => {
    const r = await request(ctx.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body).toHaveProperty('push');
  });
  test('GET /vapid-public-key tem key', async () => {
    const r = await request(ctx.app).get('/vapid-public-key');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('key');
  });
  test('404 rota invalida', async () => {
    const r = await request(ctx.app).get('/nao-existe');
    expect(r.status).toBe(404);
  });
});

describe('Auth', () => {
  test('sem token => 401', async () => {
    const r = await request(ctx.app).get('/my-devices');
    expect(r.status).toBe(401);
  });
  test('token invalido => 401', async () => {
    const r = await request(ctx.app).get('/my-devices').set('Authorization','Bearer bad.token');
    expect(r.status).toBe(401);
  });
  test('token HS256 valido passa', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});
