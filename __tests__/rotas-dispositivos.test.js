/**
 * rotas-dispositivos.test.js — Leitura de estado e envio de comandos.
 *
 * Testes de integração com o app Express real (supertest), banco e rede
 * mockados. Separado de `routes.test.js`, que reunia 29 blocos de domínios
 * diferentes em 741 linhas, a pedido do @pdrollucas no review do PR #1.
 *
 * O ambiente compartilhado — variáveis, mocks e ganchos — está em
 * `helpers/ambiente-rotas.js`.
 */
const request = require('supertest');
const { ctx, prepararAmbiente, tok, mockQuery, axios } = require('./helpers/ambiente-rotas');

prepararAmbiente();

describe('GET /devices', () => {
  test('retorna lista com status quando credenciais configuradas', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tuya_id: 'd1', name: 'Lamp', room: 'Sala', user_email: 'test@ihome.com' }], rowCount: 1,
    });
    axios.mockResolvedValueOnce({ data: { result: [{ code: 'switch_1', value: true }] } });
    const r = await request(ctx.app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.result.list.length).toBe(1);
  });

  test('sem credenciais Tuya retorna 400', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya nao encontra config
    const r = await request(ctx.app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(400); // 'nao configuradas' -> 400
  });

  test('lista vazia quando sem dispositivos', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
      rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(ctx.app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.result.list).toEqual([]);
  });
});

describe('POST /devices/:id/command', () => {
  test('envia comando ligar => 200', async () => {
    // nome do dispositivo (buscado antes das credenciais)
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'Lamp' }], rowCount: 1 });
    // getUserTuya
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
      rowCount: 1,
    });
    // getToken
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
    });
    // tuyaRequest POST command
    axios.mockResolvedValueOnce({ data: { success: true, result: {} } });
    const r = await request(ctx.app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });
    expect(r.status).toBe(200);
  });

  test('sem credenciais Tuya retorna 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nome
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya sem config
    const r = await request(ctx.app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });
    expect(r.status).toBe(500);
  });
});

describe('GET /devices/:id/status', () => {
  test('retorna status do dispositivo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
      rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { result: [{ code: 'switch_1', value: false }] } });
    const r = await request(ctx.app).get('/devices/d1/status').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /devices — dispositivo offline', () => {
  test('dispositivo offline retorna online:false', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc3', tuya_secret: 'sec3', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok3', expire_time: 7200 } },
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, tuya_id: 'd99', name: 'Lamp Offline', room: 'Sala', user_email: 'test@ihome.com' }], rowCount: 1,
    });
    // tuyaRequest throws => dispositivo offline
    axios.mockRejectedValueOnce(new Error('Device offline'));
    const r = await request(ctx.app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.result.list[0].online).toBe(false);
  });
});

describe('POST /devices/:id/command — compartilhado', () => {
  test('owner_email diferente sem permissao => 403', async () => {
    // pool.query para verificar share — nao encontrado
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(ctx.app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: 'outro@email.com' });
    expect(r.status).toBe(403);
  });

  test('owner_email com permissao view => 403', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'view' }], rowCount: 1 });
    const r = await request(ctx.app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: 'dono@email.com' });
    expect(r.status).toBe(403);
  });
});
