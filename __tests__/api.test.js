const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// -------------------------------------------------------
// Mini-app isolado para testar as rotas sem banco real
// -------------------------------------------------------
const SECRET = 'test-secret';

function makeToken(email = 'test@ihome.com', id = 'user-1') {
  return jwt.sign({ email, sub: id }, SECRET, { algorithm: 'HS256' });
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.user = { email: decoded.email, id: decoded.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// Simula o banco de dados em memória
const db = {
  devices: [{ id: 1, user_email: 'test@ihome.com', name: 'Lâmpada Sala', tuya_id: 'dev-1', room: 'Sala' }],
  alerts: [{ id: 1, user_email: 'test@ihome.com', message: 'Dispositivo offline', read: false }],
  schedules: [{ id: 1, user_email: 'test@ihome.com', device_name: 'Lâmpada', on_time: '07:00', off_time: '22:00', active: true }],
  shares: [],
};

const app = express();
app.use(express.json());

// Rotas de dispositivos
app.get('/my-devices', authMiddleware, (req, res) => {
  const devices = db.devices.filter(d => d.user_email === req.user.email);
  res.json(devices);
});

app.post('/my-devices', authMiddleware, (req, res) => {
  const { name, tuya_id, room } = req.body;
  if (!name || !tuya_id) return res.status(400).json({ error: 'name e tuya_id obrigatórios' });
  const device = { id: db.devices.length + 1, user_email: req.user.email, name, tuya_id, room: room || '' };
  db.devices.push(device);
  res.status(201).json(device);
});

app.delete('/my-devices/:id', authMiddleware, (req, res) => {
  const idx = db.devices.findIndex(d => d.id === Number(req.params.id) && d.user_email === req.user.email);
  if (idx === -1) return res.status(404).json({ error: 'Dispositivo não encontrado' });
  db.devices.splice(idx, 1);
  res.json({ ok: true });
});

// Rotas de alertas
app.get('/alerts', authMiddleware, (req, res) => {
  res.json(db.alerts.filter(a => a.user_email === req.user.email));
});

app.put('/alerts/read-all', authMiddleware, (req, res) => {
  db.alerts.forEach(a => { if (a.user_email === req.user.email) a.read = true; });
  res.json({ ok: true });
});

app.delete('/alerts', authMiddleware, (req, res) => {
  const before = db.alerts.length;
  db.alerts = db.alerts.filter(a => a.user_email !== req.user.email);
  res.json({ deleted: before - db.alerts.length });
});

// Rotas de schedules
app.get('/schedules', authMiddleware, (req, res) => {
  res.json(db.schedules.filter(s => s.user_email === req.user.email));
});

// Compartilhamento
app.post('/shares', authMiddleware, (req, res) => {
  const { guest_email, permission } = req.body;
  if (!guest_email) return res.status(400).json({ error: 'guest_email obrigatório' });
  if (guest_email === req.user.email) return res.status(400).json({ error: 'Você não pode convidar a si mesmo' });
  db.shares.push({ owner: req.user.email, guest_email, permission: permission || 'control' });
  res.status(201).json({ ok: true });
});

// -------------------------------------------------------
// Testes
// -------------------------------------------------------
describe('Dispositivos', () => {
  test('GET /my-devices retorna lista do usuário autenticado', async () => {
    const res = await request(app)
      .get('/my-devices')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('name');
  });

  test('GET /my-devices sem token retorna 401', async () => {
    const res = await request(app).get('/my-devices');
    expect(res.status).toBe(401);
  });

  test('GET /my-devices com token inválido retorna 401', async () => {
    const res = await request(app)
      .get('/my-devices')
      .set('Authorization', 'Bearer token.invalido');
    expect(res.status).toBe(401);
  });

  test('POST /my-devices cria dispositivo com dados válidos', async () => {
    const res = await request(app)
      .post('/my-devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ name: 'Tomada Quarto', tuya_id: 'dev-999', room: 'Quarto' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Tomada Quarto');
  });

  test('POST /my-devices sem name retorna 400', async () => {
    const res = await request(app)
      .post('/my-devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ tuya_id: 'dev-999' });
    expect(res.status).toBe(400);
  });

  test('DELETE /my-devices/:id remove dispositivo existente', async () => {
    const res = await request(app)
      .delete('/my-devices/1')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('DELETE /my-devices/:id inexistente retorna 404', async () => {
    const res = await request(app)
      .delete('/my-devices/9999')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(404);
  });
});

describe('Alertas', () => {
  test('GET /alerts retorna alertas do usuário', async () => {
    const res = await request(app)
      .get('/alerts')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('PUT /alerts/read-all marca todos como lidos', async () => {
    const res = await request(app)
      .put('/alerts/read-all')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('DELETE /alerts limpa alertas do usuário', async () => {
    const res = await request(app)
      .delete('/alerts')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deleted');
  });
});

describe('Agendamentos', () => {
  test('GET /schedules retorna lista de schedules', async () => {
    const res = await request(app)
      .get('/schedules')
      .set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Compartilhamento', () => {
  test('POST /shares com guest_email válido cria convite', async () => {
    const res = await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ guest_email: 'convidado@email.com', permission: 'view' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  test('POST /shares sem guest_email retorna 400', async () => {
    const res = await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('POST /shares para si mesmo retorna 400', async () => {
    const res = await request(app)
      .post('/shares')
      .set('Authorization', `Bearer ${makeToken('test@ihome.com')}`)
      .send({ guest_email: 'test@ihome.com' });
    expect(res.status).toBe(400);
  });
});
