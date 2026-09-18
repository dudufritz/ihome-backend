/**
 * rotas-alertas.test.js — Alertas de conectividade.
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

describe('GET /alerts', () => {
  test('retorna alertas', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,message:'offline',read:false}],rowCount:1});
    const r = await request(ctx.app).get('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].message).toBe('offline');
  });
  test('sem alertas retorna []', async () => {
    const r = await request(ctx.app).get('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('PUT /alerts/read-all', () => {
  test('marca como lidos => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:3});
    const r = await request(ctx.app).put('/alerts/read-all').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

describe('DELETE /alerts', () => {
  test('apaga alertas => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:2});
    const r = await request(ctx.app).delete('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});
