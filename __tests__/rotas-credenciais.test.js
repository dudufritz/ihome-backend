/**
 * rotas-credenciais.test.js — Credenciais Tuya do usuário.
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

describe('GET /tuya-credentials', () => {
  test('sem config => configured:false', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/tuya-credentials').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
  });
  test('com config => configured:true e access_id', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{tuya_access_id:'acc-1',tuya_base_url:'https://openapi.tuyaus.com'}],rowCount:1});
    const r = await request(ctx.app).get('/tuya-credentials').set('Authorization',`Bearer ${tok()}`);
    expect(r.body.configured).toBe(true);
    expect(r.body.tuya_access_id).toBe('acc-1');
  });
});

describe('POST /tuya-credentials', () => {
  test('dados validos => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(ctx.app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`)
      .send({tuya_access_id:'a',tuya_secret:'b',tuya_base_url:'https://openapi.tuyaus.com'});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('sem access_id => 400', async () => {
    const r = await request(ctx.app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`).send({tuya_secret:'b'});
    expect(r.status).toBe(400);
  });
  test('sem secret => 400', async () => {
    const r = await request(ctx.app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`).send({tuya_access_id:'a'});
    expect(r.status).toBe(400);
  });
});
