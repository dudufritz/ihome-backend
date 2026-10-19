/**
 * rotas-push.test.js — Inscrição de notificações push.
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

describe('POST /push-subscribe', () => {
  test('registra assinatura => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(ctx.app).post('/push-subscribe').set('Authorization',`Bearer ${tok()}`)
      .send({subscription:{endpoint:'https://fcm.example.com/abc',keys:{auth:'a',p256dh:'b'}}});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('sem subscription => 500 (TypeError nao verificado na rota)', async () => {
    const r = await request(ctx.app).post('/push-subscribe').set('Authorization',`Bearer ${tok()}`).send({});
    expect(r.status).toBe(500);
  });
});

describe('DELETE /push-subscribe', () => {
  test('remove assinatura => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(ctx.app).delete('/push-subscribe').set('Authorization',`Bearer ${tok()}`)
      .send({endpoint:'https://fcm.example.com/abc'});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});
