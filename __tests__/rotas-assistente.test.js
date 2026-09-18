/**
 * rotas-assistente.test.js — Assistente em linguagem natural.
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

describe('POST /ai-command', () => {
  test('sem command => 400', async () => {
    const r = await request(ctx.app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({});
    expect(r.status).toBe(400);
  });
  test('sem dispositivos => mensagem informativa', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'liga luz'});
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/dispositivos/i);
  });
  test('comando list via Gemini mock', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,name:'Lamp',tuya_id:'d1',room:'Sala'}],rowCount:1});
    axios.post.mockResolvedValueOnce({data:{candidates:[{content:{parts:[{text:'{"action":"list","message":"Lamp Sala"}'}]}}]}});
    const r = await request(ctx.app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'lista'});
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });
  test('Gemini falha => 500', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,name:'Lamp',tuya_id:'d1',room:'Sala'}],rowCount:1});
    axios.post.mockRejectedValueOnce(new Error('API error'));
    const r = await request(ctx.app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'liga'});
    expect(r.status).toBe(500);
  });
});

describe('POST /ai-command — acoes Tuya', () => {
  test('acao control — liga dispositivo especifico', async () => {
    // pool.query para listar dispositivos
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Lamp', tuya_id: 'd1', room: 'Sala' }], rowCount: 1,
    });
    // Gemini retorna control
    axios.post.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ action: 'control', deviceId: 'd1', deviceName: 'Lamp', state: true, message: 'Ligando' }) }] } }] },
    });
    // getUserTuya para tuyaRequest
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    // getToken
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    // tuyaRequest
    axios.mockResolvedValueOnce({ data: { success: true } });
    const r = await request(ctx.app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'liga lamp' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });

  test('acao schedule — cria agendamento', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Lamp', tuya_id: 'd1', room: 'Sala' }], rowCount: 1,
    });
    axios.post.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ action: 'schedule', deviceId: 'd1', deviceName: 'Lamp', onTime: '07:00', offTime: '22:00', message: 'Agendado' }) }] } }] },
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT schedule
    const r = await request(ctx.app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'agenda lamp 7h' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });

  test('acao control_all — desliga tudo', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: 'Lamp', tuya_id: 'd1', room: 'Sala' },
        { id: 2, name: 'TV', tuya_id: 'd2', room: 'Sala' },
      ], rowCount: 2,
    });
    axios.post.mockResolvedValueOnce({
      data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ action: 'control_all', state: false, message: 'Desligando tudo' }) }] } }] },
    });
    // getUserTuya
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    // getToken para d1
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    // tuyaRequest d1 e d2
    axios.mockResolvedValueOnce({ data: { success: true } });
    axios.mockResolvedValueOnce({ data: { success: true } });
    const r = await request(ctx.app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'desliga tudo' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });
});
