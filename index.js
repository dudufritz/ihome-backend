require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');

// Configura VAPID para notificações push
let pushReady = false;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:admin@ihomeauto.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    pushReady = true;
    console.log('✅ Web Push configurado com VAPID.');
  } else {
    console.warn('⚠️ VAPID keys não encontradas — push notifications desativadas.');
  }
} catch (e) {
  console.error('❌ Erro ao configurar VAPID:', e.message);
}

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
  // Tabela de agendamentos (rotinas criadas pelo assistente IA)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_schedules (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      on_time TEXT,
      off_time TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Tabela de alertas reais
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_alerts (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Cache do último status conhecido de cada dispositivo
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_status_cache (
      user_email TEXT NOT NULL,
      device_id TEXT NOT NULL,
      online BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_email, device_id)
    )
  `);
  // Assinaturas de push notification por usuário
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      subscription JSONB NOT NULL,
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

// ── PUSH NOTIFICATIONS ───────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, push: pushReady }));

app.get('/vapid-public-key', (req, res) => {
  res.json({ key: pushReady ? (process.env.VAPID_PUBLIC_KEY || '') : '' });
});

app.post('/push-subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    // Remove assinatura antiga deste dispositivo se já existir
    await pool.query(
      "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
      [req.user.email, subscription.endpoint]
    );
    await pool.query(
      'INSERT INTO push_subscriptions (user_email, subscription) VALUES ($1, $2)',
      [req.user.email, JSON.stringify(subscription)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/push-subscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await pool.query(
      "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
      [req.user.email, endpoint]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendPushToUser(userEmail, title, body) {
  try {
    const subs = await pool.query(
      'SELECT subscription FROM push_subscriptions WHERE user_email = $1',
      [userEmail]
    );
    for (const row of subs.rows) {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, icon: '/logo192.png' }));
      } catch (e) {
        // Remove assinatura inválida
        if (e.statusCode === 410) {
          await pool.query(
            "DELETE FROM push_subscriptions WHERE user_email = $1 AND subscription->>'endpoint' = $2",
            [userEmail, row.subscription.endpoint]
          );
        }
      }
    }
  } catch (err) {
    console.error('Push error:', err.message);
  }
}

// ── ALERTAS ──────────────────────────────────────────────────

app.get('/alerts', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_alerts WHERE user_email = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.email]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/alerts/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE user_alerts SET read = true WHERE user_email = $1', [req.user.email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/alerts', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM user_alerts WHERE user_email = $1', [req.user.email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POLLING: MONITORAR DISPOSITIVOS A CADA 5 MIN ─────────────
async function monitorDevices() {
  try {
    const usersResult = await pool.query(
      'SELECT DISTINCT ud.user_email FROM user_devices ud JOIN user_tuya_config utc ON ud.user_email = utc.user_email'
    );
    for (const { user_email } of usersResult.rows) {
      try {
        const config = await getUserTuya(user_email);
        const { tuya_access_id: ID, tuya_secret: SECRET, tuya_base_url: BASE } = config;
        const devResult = await pool.query('SELECT * FROM user_devices WHERE user_email = $1', [user_email]);

        for (const device of devResult.rows) {
          try {
            const s = await tuyaRequest('GET', `/v1.0/iot-03/devices/${device.tuya_id}/status`, ID, SECRET, BASE);
            const statusMap = {};
            (s?.result || []).forEach(item => { statusMap[item.code] = item.value; });
            const isOnline = true;

            // Verifica cache anterior
            const cache = await pool.query(
              'SELECT online FROM device_status_cache WHERE user_email = $1 AND device_id = $2',
              [user_email, device.tuya_id]
            );

            if (cache.rows.length > 0) {
              const wasOnline = cache.rows[0].online;
              if (!wasOnline && isOnline) {
                await pool.query(
                  'INSERT INTO user_alerts (user_email, device_id, device_name, type, message) VALUES ($1, $2, $3, $4, $5)',
                  [user_email, device.tuya_id, device.name, 'online', `${device.name} voltou a ficar online.`]
                );
                await sendPushToUser(user_email, '✅ Dispositivo online', `${device.name} voltou a ficar online.`);
              }
            }

            // Atualiza cache
            await pool.query(
              `INSERT INTO device_status_cache (user_email, device_id, online, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (user_email, device_id) DO UPDATE SET online = $3, updated_at = NOW()`,
              [user_email, device.tuya_id, isOnline]
            );
          } catch {
            // Dispositivo offline
            const cache = await pool.query(
              'SELECT online FROM device_status_cache WHERE user_email = $1 AND device_id = $2',
              [user_email, device.tuya_id]
            );
            if (cache.rows.length === 0 || cache.rows[0].online === true) {
              await pool.query(
                'INSERT INTO user_alerts (user_email, device_id, device_name, type, message) VALUES ($1, $2, $3, $4, $5)',
                [user_email, device.tuya_id, device.name, 'offline', `${device.name} ficou offline.`]
              );
              await sendPushToUser(user_email, '⚠️ Dispositivo offline', `${device.name} ficou offline.`);
              await pool.query(
                `INSERT INTO device_status_cache (user_email, device_id, online, updated_at)
                 VALUES ($1, $2, false, NOW())
                 ON CONFLICT (user_email, device_id) DO UPDATE SET online = false, updated_at = NOW()`,
                [user_email, device.tuya_id]
              );
            }
          }
        }
      } catch (e) {
        console.error(`Monitor erro para ${user_email}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Monitor geral erro:', err.message);
  }
}

setInterval(monitorDevices, 5 * 60 * 1000); // a cada 5 minutos

// ── AGENDAMENTOS ─────────────────────────────────────────────

app.get('/schedules', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM user_schedules WHERE user_email = $1 AND active = true ORDER BY created_at DESC',
      [req.user.email]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/schedules/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_schedules WHERE id = $1 AND user_email = $2',
      [req.params.id, req.user.email]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ASSISTENTE IA (Gemini) ────────────────────────────────────

app.post('/ai-command', authMiddleware, async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Comando não fornecido.' });

    const devResult = await pool.query(
      'SELECT * FROM user_devices WHERE user_email = $1',
      [req.user.email]
    );
    const devices = devResult.rows;

    if (devices.length === 0) {
      return res.json({ message: 'Você não tem dispositivos cadastrados ainda. Adicione seus dispositivos em Configurações.' });
    }

    const deviceList = devices.map(d =>
      `- Nome: "${d.name}", ID: ${d.tuya_id}, Cômodo: ${d.room || 'não definido'}`
    ).join('\n');

    const prompt = `Você é o assistente de automação residencial iHome. Interprete o comando do usuário e retorne APENAS um JSON válido.

Dispositivos disponíveis:
${deviceList}

Ações possíveis:

1. Controlar um dispositivo:
{"action":"control","deviceId":"ID_EXATO","deviceName":"NOME","state":true,"message":"Mensagem amigável"}

2. Controlar todos os dispositivos:
{"action":"control_all","state":true,"message":"Mensagem amigável"}

3. Criar agendamento (rotina):
{"action":"schedule","deviceId":"ID_EXATO","deviceName":"NOME","onTime":"HH:MM","offTime":"HH:MM","message":"Mensagem amigável"}
(onTime e offTime são opcionais — inclua apenas os que o usuário mencionou)

4. Listar dispositivos:
{"action":"list","message":"Descreva os dispositivos disponíveis aqui"}

5. Não entendeu:
{"action":"unknown","message":"Explicação do que não entendeu e como o usuário pode reformular"}

Regras importantes:
- state true = ligar, false = desligar
- Use SEMPRE o ID exato da lista de dispositivos
- Responda SOMENTE com o JSON, sem texto extra, sem markdown, sem \`\`\`

Comando do usuário: "${command}"`;

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      }
    );

    const rawText = geminiRes.data.candidates[0].content.parts[0].text.trim();
    const jsonText = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(jsonText);

    if (parsed.action === 'control') {
      const config = await getUserTuya(req.user.email);
      await tuyaRequest(
        'POST', `/v1.0/iot-03/devices/${parsed.deviceId}/commands`,
        config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
        { commands: [{ code: 'switch_1', value: parsed.state }] }
      );
      return res.json({ message: parsed.message });
    }

    if (parsed.action === 'control_all') {
      const config = await getUserTuya(req.user.email);
      await Promise.all(devices.map(d =>
        tuyaRequest(
          'POST', `/v1.0/iot-03/devices/${d.tuya_id}/commands`,
          config.tuya_access_id, config.tuya_secret, config.tuya_base_url,
          { commands: [{ code: 'switch_1', value: parsed.state }] }
        ).catch(() => {})
      ));
      return res.json({ message: parsed.message });
    }

    if (parsed.action === 'schedule') {
      await pool.query(
        'INSERT INTO user_schedules (user_email, device_id, device_name, on_time, off_time) VALUES ($1, $2, $3, $4, $5)',
        [req.user.email, parsed.deviceId, parsed.deviceName, parsed.onTime || null, parsed.offTime || null]
      );
      return res.json({ message: parsed.message });
    }

    return res.json({ message: parsed.message });

  } catch (err) {
    console.error('AI error:', err.message);
    res.status(500).json({ error: 'Erro ao processar: ' + err.message });
  }
});

// ── CRON: EXECUTAR AGENDAMENTOS A CADA MINUTO ────────────────
setInterval(async () => {
  try {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const result = await pool.query(
      `SELECT s.*, c.tuya_access_id, c.tuya_secret, c.tuya_base_url
       FROM user_schedules s
       JOIN user_tuya_config c ON s.user_email = c.user_email
       WHERE s.active = true`
    );
    for (const s of result.rows) {
      if (s.on_time === currentTime) {
        await tuyaRequest('POST', `/v1.0/iot-03/devices/${s.device_id}/commands`,
          s.tuya_access_id, s.tuya_secret, s.tuya_base_url,
          { commands: [{ code: 'switch_1', value: true }] }
        ).catch(e => console.error(`Agendamento ON erro:`, e.message));
        console.log(`⏰ Ligou: ${s.device_name}`);
      }
      if (s.off_time === currentTime) {
        await tuyaRequest('POST', `/v1.0/iot-03/devices/${s.device_id}/commands`,
          s.tuya_access_id, s.tuya_secret, s.tuya_base_url,
          { commands: [{ code: 'switch_1', value: false }] }
        ).catch(e => console.error(`Agendamento OFF erro:`, e.message));
        console.log(`⏰ Desligou: ${s.device_name}`);
      }
    }
  } catch (err) {
    console.error('Cron erro:', err.message);
  }
}, 60000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🏠 iHome API rodando em http://localhost:${PORT}`));
