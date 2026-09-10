/**
 * routes.test.js — Testes de integracao com app REAL
 */
process.env.JWT_SECRET = 'test-secret-key';
process.env.DATABASE_URL = 'postgresql://mock:mock@localhost/mock';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
// O assistente exige a chave configurada; sem ela a rota responde 503 antes
// de chamar o modelo. Como estes testes exercitam justamente o caminho do
// Gemini (com axios mockado), a chave precisa existir no ambiente de teste.
process.env.GEMINI_API_KEY = 'test-gemini-key';

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => {
  // O mock precisa expor a mesma interface do Pool real: alem de query(),
  // o codigo de producao registra um listener de erro com pool.on('error').
  const Pool = jest.fn().mockImplementation(() => ({
    query: mockQuery,
    on: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  }));
  return { Pool };
});
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
  generateVAPIDKeys: jest.fn(),
}));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'test-id' }),
  })),
}));
jest.mock('axios', () => {
  const fn = jest.fn();
  fn.get  = jest.fn();
  fn.post = jest.fn();
  return fn;
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const axios = require('axios');

let app, tokenCache;
beforeAll(() => { const mod = require('../index'); app = mod.app; tokenCache = mod.tokenCache; });
beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  axios.mockReset();
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  // Limpa cache de tokens Tuya para evitar reuso entre testes
  if (tokenCache) Object.keys(tokenCache).forEach(k => delete tokenCache[k]);
  // Restaura axios mock padrao
  axios.get = jest.fn();
  axios.post = jest.fn();
});
afterAll(() => { jest.clearAllMocks(); });

function tok(email = 'test@ihome.com', sub = 'u1') {
  return jwt.sign({ email, sub }, process.env.JWT_SECRET, { algorithm: 'HS256' });
}

// ── PUBLICAS ──────────────────────────────────────────────────
describe('Publicas', () => {
  test('GET / ok', async () => {
    const r = await request(app).get('/');
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/iHome/i);
  });
  test('GET /health ok:true push presente', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body).toHaveProperty('push');
  });
  test('GET /vapid-public-key tem key', async () => {
    const r = await request(app).get('/vapid-public-key');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('key');
  });
  test('404 rota invalida', async () => {
    const r = await request(app).get('/nao-existe');
    expect(r.status).toBe(404);
  });
});

// ── AUTH ──────────────────────────────────────────────────────
describe('Auth', () => {
  test('sem token => 401', async () => {
    const r = await request(app).get('/my-devices');
    expect(r.status).toBe(401);
  });
  test('token invalido => 401', async () => {
    const r = await request(app).get('/my-devices').set('Authorization','Bearer bad.token');
    expect(r.status).toBe(401);
  });
  test('token HS256 valido passa', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

// ── TUYA CREDENTIALS ─────────────────────────────────────────
describe('GET /tuya-credentials', () => {
  test('sem config => configured:false', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/tuya-credentials').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
  });
  test('com config => configured:true e access_id', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{tuya_access_id:'acc-1',tuya_base_url:'https://openapi.tuyaus.com'}],rowCount:1});
    const r = await request(app).get('/tuya-credentials').set('Authorization',`Bearer ${tok()}`);
    expect(r.body.configured).toBe(true);
    expect(r.body.tuya_access_id).toBe('acc-1');
  });
});

describe('POST /tuya-credentials', () => {
  test('dados validos => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`)
      .send({tuya_access_id:'a',tuya_secret:'b',tuya_base_url:'https://openapi.tuyaus.com'});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('sem access_id => 400', async () => {
    const r = await request(app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`).send({tuya_secret:'b'});
    expect(r.status).toBe(400);
  });
  test('sem secret => 400', async () => {
    const r = await request(app).post('/tuya-credentials').set('Authorization',`Bearer ${tok()}`).send({tuya_access_id:'a'});
    expect(r.status).toBe(400);
  });
});

// ── MY-DEVICES ────────────────────────────────────────────────
describe('GET /my-devices', () => {
  test('retorna dispositivos proprios + compartilhados', async () => {
    const d = [{id:1,user_email:'test@ihome.com',name:'Lamp',tuya_id:'d1',room:'Sala'}];
    mockQuery.mockResolvedValueOnce({rows:d,rowCount:1}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(1);
  });
  test('sem dispositivos retorna []', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/my-devices').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('POST /my-devices', () => {
  test('cria dispositivo valido', async () => {
    const d = {id:1,user_email:'test@ihome.com',name:'Tomada',tuya_id:'d2',room:'Quarto'};
    mockQuery.mockResolvedValueOnce({rows:[d],rowCount:1});
    const r = await request(app).post('/my-devices').set('Authorization',`Bearer ${tok()}`)
      .send({name:'Tomada',tuya_id:'d2',room:'Quarto'});
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Tomada');
  });
  test('sem name => 400', async () => {
    const r = await request(app).post('/my-devices').set('Authorization',`Bearer ${tok()}`).send({tuya_id:'d2'});
    expect(r.status).toBe(400);
  });
  test('sem tuya_id => 400', async () => {
    const r = await request(app).post('/my-devices').set('Authorization',`Bearer ${tok()}`).send({name:'Lamp'});
    expect(r.status).toBe(400);
  });
});

describe('DELETE /my-devices/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).delete('/my-devices/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 200 (sem rowCount check)', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).delete('/my-devices/9999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

// ── SHARES ────────────────────────────────────────────────────
describe('GET /shares', () => {
  test('retorna lista de compartilhamentos', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,guest_email:'g@g.com',permission:'view'}],rowCount:1});
    const r = await request(app).get('/shares').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].guest_email).toBe('g@g.com');
  });
});

describe('GET /shared-with-me', () => {
  test('retorna lista de casas compartilhadas', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/shared-with-me').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });
});

describe('POST /shares', () => {
  test('convite valido => emailSent presente', async () => {
    const s = {id:1,owner_email:'t@t.com',guest_email:'g@g.com',permission:'view',status:'pending'};
    mockQuery.mockResolvedValueOnce({rows:[s],rowCount:1});
    const r = await request(app).post('/shares').set('Authorization',`Bearer ${tok()}`)
      .send({guest_email:'g@g.com',permission:'view'});
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('emailSent');
  });
  test('sem guest_email => 400', async () => {
    const r = await request(app).post('/shares').set('Authorization',`Bearer ${tok()}`).send({permission:'view'});
    expect(r.status).toBe(400);
  });
  test('convidar si mesmo => 400', async () => {
    const r = await request(app).post('/shares').set('Authorization',`Bearer ${tok('me@me.com')}`)
      .send({guest_email:'me@me.com'});
    expect(r.status).toBe(400);
  });
});

describe('DELETE /shares/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).delete('/shares/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

describe('DELETE /shared-with-me/:id', () => {
  test('remove acesso => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).delete('/shared-with-me/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

describe('Aceite/Recusa de convite', () => {
  test('accept token valido => 302 redirect accepted', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1}],rowCount:1});
    const r = await request(app).get('/shares/accept/tok-valido');
    expect(r.status).toBe(302);
  });
  test('accept token invalido => 302 redirect invalid', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/shares/accept/tok-invalido');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/invite=invalid/);
  });
  test('decline => 302 redirect declined', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).get('/shares/decline/tok');
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/invite=declined/);
  });
});

// ── ALERTAS ───────────────────────────────────────────────────
describe('GET /alerts', () => {
  test('retorna alertas', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,message:'offline',read:false}],rowCount:1});
    const r = await request(app).get('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].message).toBe('offline');
  });
  test('sem alertas retorna []', async () => {
    const r = await request(app).get('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('PUT /alerts/read-all', () => {
  test('marca como lidos => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:3});
    const r = await request(app).put('/alerts/read-all').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

describe('DELETE /alerts', () => {
  test('apaga alertas => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:2});
    const r = await request(app).delete('/alerts').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

// ── AGENDAMENTOS ──────────────────────────────────────────────
describe('GET /schedules', () => {
  test('retorna agendamentos', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,device_name:'Lamp',on_time:'07:00'}],rowCount:1});
    const r = await request(app).get('/schedules').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body[0].device_name).toBe('Lamp');
  });
  test('sem agendamentos retorna []', async () => {
    const r = await request(app).get('/schedules').set('Authorization',`Bearer ${tok()}`);
    expect(r.body).toEqual([]);
  });
});

describe('DELETE /schedules/:id', () => {
  test('remove => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).delete('/schedules/1').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('id inexistente => 200 sem rowCount check', async () => {
    const r = await request(app).delete('/schedules/9999').set('Authorization',`Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

// ── PUSH ──────────────────────────────────────────────────────
describe('POST /push-subscribe', () => {
  test('registra assinatura => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).post('/push-subscribe').set('Authorization',`Bearer ${tok()}`)
      .send({subscription:{endpoint:'https://fcm.example.com/abc',keys:{auth:'a',p256dh:'b'}}});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
  test('sem subscription => 500 (TypeError nao verificado na rota)', async () => {
    const r = await request(app).post('/push-subscribe').set('Authorization',`Bearer ${tok()}`).send({});
    expect(r.status).toBe(500);
  });
});

describe('DELETE /push-subscribe', () => {
  test('remove assinatura => success:true', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:1});
    const r = await request(app).delete('/push-subscribe').set('Authorization',`Bearer ${tok()}`)
      .send({endpoint:'https://fcm.example.com/abc'});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });
});

// ── IA ────────────────────────────────────────────────────────
describe('POST /ai-command', () => {
  test('sem command => 400', async () => {
    const r = await request(app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({});
    expect(r.status).toBe(400);
  });
  test('sem dispositivos => mensagem informativa', async () => {
    mockQuery.mockResolvedValueOnce({rows:[],rowCount:0});
    const r = await request(app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'liga luz'});
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/dispositivos/i);
  });
  test('comando list via Gemini mock', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,name:'Lamp',tuya_id:'d1',room:'Sala'}],rowCount:1});
    axios.post.mockResolvedValueOnce({data:{candidates:[{content:{parts:[{text:'{"action":"list","message":"Lamp Sala"}'}]}}]}});
    const r = await request(app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'lista'});
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });
  test('Gemini falha => 500', async () => {
    mockQuery.mockResolvedValueOnce({rows:[{id:1,name:'Lamp',tuya_id:'d1',room:'Sala'}],rowCount:1});
    axios.post.mockRejectedValueOnce(new Error('API error'));
    const r = await request(app).post('/ai-command').set('Authorization',`Bearer ${tok()}`).send({command:'liga'});
    expect(r.status).toBe(500);
  });
});

// ── DEVICES (requer Tuya mock) ────────────────────────────────
// Helper: simula resposta do getToken e tuyaRequest via axios
function mockTuya(devicesResult = [], statusResult = []) {
  // getUserTuya -> pool.query
  mockQuery.mockResolvedValueOnce({
    rows: [{ tuya_access_id: 'acc', tuya_secret: 'sec', tuya_base_url: 'https://openapi.tuyaus.com' }],
    rowCount: 1,
  });
  // getToken via axios.get
  axios.get.mockResolvedValueOnce({
    data: { success: true, result: { access_token: 'test-token', expire_time: 7200 } },
  });
  // Dispositivos do usuario via pool.query
  mockQuery.mockResolvedValueOnce({ rows: devicesResult, rowCount: devicesResult.length });
  // tuyaRequest para cada dispositivo via axios()
  statusResult.forEach(s => {
    axios.mockResolvedValueOnce({ data: { result: s } });
  });
}

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
    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.result.list.length).toBe(1);
  });

  test('sem credenciais Tuya retorna 400', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya nao encontra config
    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
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
    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
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
    const r = await request(app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }] });
    expect(r.status).toBe(200);
  });

  test('sem credenciais Tuya retorna 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nome
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya sem config
    const r = await request(app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
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
    const r = await request(app).get('/devices/d1/status').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
  });
});

// ── IA — acoes adicionais ─────────────────────────────────────
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
    const r = await request(app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'liga lamp' });
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
    const r = await request(app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'agenda lamp 7h' });
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
    const r = await request(app).post('/ai-command').set('Authorization', `Bearer ${tok()}`).send({ command: 'desliga tudo' });
    expect(r.status).toBe(200);
    expect(r.body.message).toBeDefined();
  });
});

// ── DISCOVER DEVICES ─────────────────────────────────────────
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
    // tuyaRequest GET /v1.0/iot-03/devices — retorna lista
    axios.mockResolvedValueOnce({
      data: { result: { devices: [{ id: 'd1', name: 'Lamp', category: 'dj', product_name: 'Smart Bulb', online: true }] } },
    });
    // pool.query para saved devices
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.devices).toBeDefined();
    expect(r.body.devices[0].tuya_id).toBe('d1');
  });

  test('sem credenciais Tuya retorna 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // nome
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getUserTuya sem config
    const r = await request(app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('tuyaRequest retorna lista vazia', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ tuya_access_id: 'acc2', tuya_secret: 'sec2', tuya_base_url: 'https://openapi.tuyaus.com' }], rowCount: 1,
    });
    axios.get.mockResolvedValueOnce({
      data: { success: true, result: { access_token: 'tok2', expire_time: 7200 } },
    });
    axios.mockResolvedValueOnce({ data: { result: { devices: [] } } });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).get('/discover-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.devices).toEqual([]);
  });
});

// ── CAMINHOS DE ERRO (500) ────────────────────────────────────
describe('Caminhos de erro — pool.query throws', () => {
  test('GET /my-devices => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/my-devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('POST /my-devices => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB insert error'));
    const r = await request(app).post('/my-devices').set('Authorization', `Bearer ${tok()}`)
      .send({ name: 'Lamp', tuya_id: 'd1' });
    expect(r.status).toBe(500);
  });

  test('GET /tuya-credentials => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/tuya-credentials').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /shares => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/shares').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /shared-with-me => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/shared-with-me').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /alerts => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/alerts').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('PUT /alerts/read-all => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).put('/alerts/read-all').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('GET /schedules => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).get('/schedules').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });

  test('DELETE /schedules/:id => 500 quando banco falha', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    const r = await request(app).delete('/schedules/1').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(500);
  });
});

// ── GET /devices — caminho offline ────────────────────────────
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
    const r = await request(app).get('/devices').set('Authorization', `Bearer ${tok()}`);
    expect(r.status).toBe(200);
    expect(r.body.result.list[0].online).toBe(false);
  });
});

// ── POST /devices/:id/command — acesso compartilhado ─────────
describe('POST /devices/:id/command — compartilhado', () => {
  test('owner_email diferente sem permissao => 403', async () => {
    // pool.query para verificar share — nao encontrado
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await request(app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: 'outro@email.com' });
    expect(r.status).toBe(403);
  });

  test('owner_email com permissao view => 403', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ permission: 'view' }], rowCount: 1 });
    const r = await request(app).post('/devices/d1/command').set('Authorization', `Bearer ${tok()}`)
      .send({ commands: [{ code: 'switch_1', value: true }], owner_email: 'dono@email.com' });
    expect(r.status).toBe(403);
  });
});
