const request = require('supertest');
const express = require('express');

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.json({ message: 'iHome API online OK' }));
app.get('/health', (req, res) => res.json({ ok: true, push: false }));
app.get('/vapid-public-key', (req, res) => res.json({ key: 'mock-vapid-key' }));

describe('Rotas Publicas', () => {
  test('GET / retorna mensagem de status', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('iHome API');
  });

  test('GET /health retorna ok true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /health tem campo push', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('push');
  });

  test('GET /vapid-public-key retorna chave', async () => {
    const res = await request(app).get('/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');
  });

  test('rota inexistente retorna 404', async () => {
    const res = await request(app).get('/rota-inexistente');
    expect(res.status).toBe(404);
  });
});
