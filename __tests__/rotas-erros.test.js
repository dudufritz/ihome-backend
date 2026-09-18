/**
 * rotas-erros.test.js — Caminhos de erro do banco.
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

describe('Caminhos de erro — pool.query throws', () => {
  test('GET /my-devices => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/my-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('POST /my-devices => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB insert error'));
    const r = await request(ctx.app).post('/my-devices').set('Authorization', `Bearer ${tok()}`)
      .send({ name: 'Lamp', tuya_id: 'd1' });
    expect(r.status).toBe(500);
  });

  test('GET /tuya-credentials => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/tuya-credentials').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /shares => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/shares').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /shared-with-me => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/shared-with-me').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /alerts => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/alerts').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('PUT /alerts/read-all => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).put('/alerts/read-all').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /schedules => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).get('/schedules').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('DELETE /schedules/:id => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(ctx.app).delete('/schedules/1').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });
});
