/**
 * rotas-compartilhamento.test.js — Compartilhamento de casa: convite, aceite, recusa e revogação.
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

describe('GET /shares', () => {
  test('retorna lista de compartilhamentos', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,guest_email:'g@g.com',permission:'view'}],rowCount:1});
    const r = await request(ctx.app).get('/shares').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].guest_email).toBe('g@g.com');
  });
});

describe('GET /shared-with-me', () => {
  test('retorna lista de casas compartilhadas', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/shared-with-me').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});

describe('POST /shares', () => {
  test('convite valido => emailSent presente', async () => {
    const s = {id:1,owner_email:'t@t.com',guest_email:'g@g.com',permission:'view',status:'pending'};
    mockQuery.mockResolvedValueOnce({rows:[s],rowCount:1});
    const r = await request(ctx.app).post('/shares').set('Authorization',`Bearer ${tok()}`)
      .send({guest_email:'g@g.com',permission:'view'});
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('emailSent');
  });
  test('sem guest_email => 400', async () => {
    const r = await request(ctx.app).post('/shares').set('Authorization',`Bearer ${tok()}`).send({permission:'view'});
    expect(r.status).toBe(400);
  });
  test('convidar si mesmo => 400', async () => {
    const r = await request(ctx.app).post('/shares').set('Authorization',`Bearer ${tok('me@me.com')}`)
      .send({guest_email:'me@me.com'});
    expect(r.status).toBe(400);
  });
});

describe('DELETE /shares/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows:[{id:1, owner_email:'u@test.com', guest_email:'convidado@test.com', permission:'control', status:'accepted'}],
      rowCount:1,
    });
    const r = await request(ctx.app).delete('/shares/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 404', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).delete('/shares/999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(404);
  });
});

describe('DELETE /shared-with-me/:id', () => {
  test('remove acesso => success:true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows:[{id:1, owner_email:'dono@test.com', guest_email:'u@test.com', permission:'control', status:'accepted'}],
      rowCount:1,
    });
    const r = await request(ctx.app).delete('/shared-with-me/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 404', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).delete('/shared-with-me/999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(404);
  });
});

describe('Aceite/Recusa de convite', () => {
  test('accept token valido => 302 redirect accepted', async () => {
    mockQuery.mockResolvedValueOnce({
      rows:[{id:1, owner_email:'dono@test.com', guest_email:'convidado@test.com', permission:'control'}],
      rowCount:1,
    });
    const r = await request(ctx.app).get('/shares/accept/tok-valido');
    expect(r.status).toBe(302);
  });
  test('accept token invalido => 302 redirect invalid', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/shares/accept/tok-invalido');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/invite=invalid/);
  });
  test('decline => 302 redirect declined', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/shares/decline/tok');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/invite=declined/);
  });
});
