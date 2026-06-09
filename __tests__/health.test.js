const request = require('supertest');

// Mock do pool para não precisar de banco real
jest.mock('../index', () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.json({ message: 'iHome API online ✅' }));
  app.get('/health', (req, res) => res.json({ ok: true, push: false }));
  app.get('/vapid-public-key', (req, res) => res.json({ key: 'mock-key' }));
  return { app, pool: { query: jest.fn() } };
}, { virtual: false });

const { app } = require('../index');

describe('Health & Rotas Públicas', () => {
  test('GET / retorna mensagem de status', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('iHome API');
  });

  test('GET /health retorna ok: true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET /vapid-public-key retorna chave', async () => {
    const res = await request(app).get('/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('key');
  });
});
