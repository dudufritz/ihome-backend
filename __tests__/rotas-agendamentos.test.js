/**
 * rotas-agendamentos.test.js — Rotinas agendadas.
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

describe('GET /schedules', () => {
  test('retorna agendamentos', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,device_name:'Lamp',on_time:'07:00'}],rowCount:1});
    const r = await request(ctx.app).get('/schedules').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].device_name).toBe('Lamp');
  });
  test('sem agendamentos retorna []', async () => {
    const r = await request(ctx.app).get('/schedules').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('DELETE /schedules/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(ctx.app).delete('/schedules/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 200 sem rowCount check', async () => {
    const r = await request(ctx.app).delete('/schedules/9999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});
