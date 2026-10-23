/**
 * rotas-meus-dispositivos.test.js — Cadastro de dispositivos do usuário e descoberta na Tuya.
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

describe('GET /my-devices', () => {
  test('retorna dispositivos proprios + compartilhados', async () => {
    const d = [{id:1,user_email:'test@ihome.com',name:'Lamp',tuya_id:'d1',room:'Sala'}];
    mockQuery.mockResolvedValueOnce({rows:d,rowCount:1}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1);
  });
  test('sem dispositivos retorna []', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('POST /my-devices', () => {
  test('cria dispositivo valido', async () => {
    const d = {id:1,user_email:'test@ihome.com',name:'Tomada',tuya_id:'d2',room:'Quarto'};
    mockQuery.mockResolvedValueOnce({rows:[d],rowCount:1});
    const r = await request(ctx.app).post('/my-devices').set('Authorization',`Bearer ${tok()}`)
      .send({name:'Tomada',tuya_id:'d2',room:'Quarto'});
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Tomada');
  });
  test('sem name => 400', async () => {
    const r = await request(ctx.app).post('/my-devices').set('Authorization',`Bearer ${tok()}`).send({tuya_id:'d2'});
    expect(r.status).toBe(400);
  });
  test('sem tuya_id => 400', async () => {
    const r = await request(ctx.app).post('/my-devices').set('Authorization',`Bearer ${tok()}`).send({name:'Lamp'});
    expect(r.status).toBe(400);
  });
});

describe('DELETE /my-devices/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(ctx.app).delete('/my-devices/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 200 (sem rowCount check)', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(ctx.app).delete('/my-devices/9999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

describe('GET /discover-devices', () => {
  test('retorna dispositivos da conta Tuya', async () => {
    // getUserTuya
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    // getToken
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok', expire_time: 7200 } },
    });
    // 1a consulta: /v1.0/iot-01/associated-users/devices — dispositivos que
    // vieram do app Smart Life, que e o caso da maioria das contas.
    axios.mockResolvedValueOnce({
      data: { result: { devices: [{ id: 'd1', name: 'Lamp', category: 'dj', product_name: 'Smart Bulb', online: true }] } },
    });
    // pool.query para saved devices
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.devices).toBeDefined();
    expect(r.body.devices[0].tuya_id).toBe('d1');
    // Achando pelo primeiro caminho, o segundo nem e consultado.
    const urls = axios.mock.calls.map(c => c[0]?.url || '');
    expect(urls.some(u => /associated-users\/devices/.test(u))).toBe(true);
    expect(urls.some(u => /iot-03\/devices/.test(u))).toBe(false);
  });

  test('cai para o projeto da nuvem quando o app nao tem nada vinculado', async () => {
    // O caso inverso: projeto industrial, com dispositivos cadastrados direto
    // na nuvem em vez de virem de uma conta do app.
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc3', tuya_secret: 'sec3', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok3', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { result: { devices: [] } } });          // associated-users: vazio
    axios.mockResolvedValueOnce({                                                 // iot-03: tem
      data: { result: { devices: [{ id: 'd9', name: 'Sensor', category: 'pir', online: false }] } },
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.devices[0].tuya_id).toBe('d9');
    const urls = axios.mock.calls.map(c => c[0]?.url || '');
    expect(urls.some(u => /associated-users\/devices/.test(u))).toBe(true);
    expect(urls.some(u => /iot-03\/devices/.test(u))).toBe(true);
  });

  test('sem credenciais Tuya retorna 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nome
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya sem config
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('tuyaRequest retorna lista vazia', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc2', tuya_secret: 'sec2', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok2', expire_time: 7200 } },
    });
    // Os DOIS caminhos vazios: conta sem nenhum dispositivo em lugar nenhum.
    axios.mockResolvedValueOnce({ data: { result: { devices: [] } } }); // associated-users
    axios.mockResolvedValueOnce({ data: { result: { devices: [] } } }); // iot-03
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.devices).toEqual([]);
  });

  // A distincao que estes dois testes guardam: a Tuya responde HTTP 200 tanto
  // para "nao ha dispositivos" quanto para "voce nao pode perguntar". O teste
  // acima cobre o primeiro caso; os de baixo garantem que o segundo nao seja
  // confundido com ele, porque a acao do usuario e oposta.
  test('recusa da Tuya vira erro, nao lista vazia', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc4', tuya_secret: 'sec4', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok4', expire_time: 7200 } },
    });
    // Permissao negada: HTTP 200, success false, sem `result`.
    axios.mockResolvedValueOnce({
      data: { success: false, code: 1106, msg: 'permission deny' },
    });
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Service API/);
    // Nao pode ter caido para o segundo caminho: a conta nao foi consultada
    // com sucesso, entao "o primeiro nao trouxe nada" nem se aplica.
    const urls = axios.mock.calls.map((c) => c[0]?.url || '');
    expect(urls.some((u) => /iot-03\/devices/.test(u))).toBe(false);
  });

  test('avaliacao do projeto vencida explica o que renovar', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc5', tuya_secret: 'sec5', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok5', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({
      data: { success: false, code: 28841002, msg: 'No permissions. This project is not authorized to call this API' },
    });
    const r = await request(ctx.app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/avalia/i);
  });
});
