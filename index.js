require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// ── BANCO DE DADOS ───────────────────────────────────────────
// O Pool é a "conexão" com o banco de dados PostgreSQL
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Cria as tabelas automaticamente quando o servidor inicia
async function initDB() {
  // Tabela de credenciais Tuya de cada usuário
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_tuya_config (
      id SERIAL PRIMARY KEY,
      user_email TEXT UNIQUE NOT NULL,
      tuya_access_id TEXT NOT NULL,
      tuya_secret TEXT NOT NULL,
      tuya_base_url TEXT NOT NULL DEFAULT 'https://openapi.tuyaus.com',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Tabela de dispositivos de cada usuário
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      tuya_id TEXT NOT NULL,
      name TEXT NOT NULL,
      room TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Banco de dados iniciado!');
}
initDB().catch(err => console.error('❌ Erro ao iniciar banco:', err));

// ── AUTENTICAÇÃO (Supabase JWT) ──────────────────────────────
// Verifica o "crachá" digital do usuário antes de qualquer operação
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token não fornecido' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    req.user = { email: decoded.email, id: decoded.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado. Faça login novamente.' });
  }
}

// ── CREDENCIAIS TUYA ─────────────────────────────────────────

// Verifica se o usuário já configurou as credenciais
app.get('/tuya-credentials', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT tuya_access_id, tuya_base_url FROM user_tuya_config WHERE user_email = $1',
      [req.user.email]
    );
    if (result.rows.length === 0) return res.json({ configured: false });
    res.json({ configured: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salva (ou atualiza) as credenciais Tuya do usuário
app.post('/tuya-credentials', authMiddleware, async (req, res) => {
  const { tuya_access_id, tuya_secret, tuya_base_url } = req.body;
  if (!tuya_access_id || !tuya_secret) {
    return res.status(400).json({ error: 'Access ID e Secret são obrigatórios' });
  }
  try {
    await pool.query(`
      INSERT INTO user_tuya_config (user_email, tuya_access_id, tuya_secret, tuya_base_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_email) DO UPDATE
        SET tuya_access_id = $2, tuya_secret = $3, tuya_base_url = $4, updated_at = NOW()
    `, [req.user.email, tuya_access_id, tuya_secret, tuya_base_url || 'https://openapi.tuyaus.com']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DISPOSITIVOS DO USUÁRIO ──────────────────────────────────

// Lista os dispositivos cadastrados pelo usuário
app.get('/my-devices', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_devices WHERE user_email = $1 ORDER BY created_at',
      [req.user.email]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adiciona um novo dispositivo ao usuário
app.post('/my-devices', authMiddleware, async (req, res) => {
  const { tuya_id, name, room } = req.body;
  if (!tuya_id || !name) {
    return res.status(400).json({ error: 'ID do dispositivo e nome são obrigatórios' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO user_devices (user_email, tuya_id, name, room) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.email, tuya_id, name, room || '']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove um dispositivo do usuário
app.delete('/my-devices/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_devices WHERE id = $1 AND user_email = $2',
      [req.params.id, req.user.email]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FUNÇÕES TUYA ─────────────────────────────────────────────
function makeSign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}
function sha256(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}

// Cache de tokens Tuya para evitar chamadas desnecessárias
const tokenCache = {};

async function getToken(accessId, accessSecret, baseUrl) {
  const cached = tokenCache[accessId];
  if (cached && Date.now() < cached.expiry) return cached.token;
  const t = Date.now().toString();
  const s = accessId + t + ['GET', sha256(''), '', '/v1.0/token?grant_type=1'].join('\n');
  const res = await axios.get(`${baseUrl}/v1.0/token?grant_type=1`, {
    headers: { client_id: accessId, sign: makeSign(accessSecret, s), t, sign_method: 'HMAC-SHA256', nonce: '' },
  });
  if (!res.data.success) throw new Error('Falha ao autenticar na Tuya: ' + JSON.stringify(res.data));
  tokenCache[accessId] = {
    token: res.data.result.access_token,
    expiry: Date.now() + (res.data.result.expire_time * 1000) - 60000
  };
  return tokenCache[accessId].token;
}

async function tuyaRequest(method, path, accessId, accessSecret, baseUrl, body = null) {
  const token = await getToken(accessId, accessSecret, baseUrl);
  const t = Date.now().toString();
  const [urlPath, query] = path.split('?');
  const sortedQuery = query ? '?' + query.split('&').sort().join('&') : '';
  const bodyStr = body ? JSON.stringify(body) : '';
  const s = accessId + token + t + [method, sha256(bodyStr), '', urlPath + sortedQuery].join('\n');
  const res = await axios({
    method, url: `${baseUrl}${path}`,
    headers: {
      client_id: accessId, access_token: token, sign: makeSign(accessSecret, s),
      t, sign_method: 'HMAC-SHA256', nonce: '', 'Content-Type': 'application/json',
    },
    data: body || undefined,
  });
  console.log(`${method} ${path} — ok`);
  return res.data;
}

// Busca as credenciais Tuya do usuário no banco
async function getUserTuya(email) {
  const result = await pool.query('SELECT * FROM user_tuya_config WHERE user_email = $1', [email]);
  if (result.rows.length === 0) {
    throw new Error('Credenciais Tuya não configuradas. Acesse Configurações para cadastrá-las.');
  }
  return result.rows[0];
}

// ── ROTAS DE DISPOSITIVOS ────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'iHome API online ✅' }));

// Lista dispositivos do usuário com status em tempo real
app.get('/devices', authMiddleware, async (req, res) => {
  try {
    const config = await getUserTuya(req.user.email);
    const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;

    const devResult = await pool.query(
      'SELECT * FROM user_devices WHERE user_email = $1',
      [req.user.email]
    );
    const userDevices = devResult.rows;

    const list = await Promise.all(userDevices.map(async d => {
      try {
        const s = await tuyaRequest('GET', `/v1.0/iot-03/devices/${d.tuya_id}/status`, ID, SECRET, BASE);
        const statusMap = {};
        (s?.result || []).forEach(item => { statusMap[item.code] = item.value; });
        return {
          id: d.tuya_id, dbId: d.id, name: d.name,
          category_name: 'Switch', room: d.room,
          online: true, isControllable: true,
          switch_1: statusMap.switch_1 === true
        };
      } catch {
        return {
          id: d.tuya_id, dbId: d.id, name: d.name,
          category_name: 'Switch', room: d.room,
          online: false, isControllable: true, switch_1: false
        };
      }
    }));

    res.json({ result: { list }, success: true });
  } catch (err) {
    const status = err.message.includes('não configuradas') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Envia um comando para um dispositivo (ex: ligar/desligar)
app.post('/devices/:id/command', authMiddleware, async (req, res) => {
  try {
    const config = await getUserTuya(req.user.email);
    const { commands } = req.body;
    const data = await tuyaRequest(
      'POST',
      `/v1.0/iot-03/devices/${req.params.id}/commands`,
      config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
      { commands }
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consulta o status de um dispositivo específico
app.get('/devices/:id/status', authMiddleware, async (req, res) => {
  try {
    const config = await getUserTuya(req.user.email);
    const data = await tuyaRequest(
      'GET',
      `/v1.0/iot-03/devices/${req.params.id}/status`,
      config.tuya_access_id, config.tuya_secret, config.tuya_base_url
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏠 iHome API rodando em http://localhost:${PORT}`));
