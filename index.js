require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const BASE_URL = process.env.TUYA_BASE_URL;
const ACCESS_ID = process.env.TUYA_ACCESS_ID;
const ACCESS_SECRET = process.env.TUYA_ACCESS_SECRET;

const CUSTOM_DEVICES = [
  { id: '710151318cce4e127075', name: 'Interruptor Sala', room: 'Sala' },
  { id: '5702238434ab95013d64', name: 'Interruptor Fundos', room: 'Externa' },
  { id: '7808227470039f392d0a', name: 'Interruptor Sala 2', room: 'Sala' },
];

function hmac(str) {
  return crypto.createHmac('sha256', ACCESS_SECRET).update(str).digest('hex').toUpperCase();
}
function sha256(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}
async function getToken() {
  const t = Date.now().toString();
  const s = ACCESS_ID + t + '' + ['GET', sha256(''), '', '/v1.0/token?grant_type=1'].join('\n');
  const res = await axios.get(`${BASE_URL}/v1.0/token?grant_type=1`, {
    headers: { client_id: ACCESS_ID, sign: hmac(s), t, sign_method: 'HMAC-SHA256', nonce: '' },
  });
  if (!res.data.success) throw new Error(JSON.stringify(res.data));
  return res.data.result.access_token;
}
async function tuyaRequest(method, path, body = null) {
  const token = await getToken();
  const t = Date.now().toString();
  const [urlPath, query] = path.split('?');
  const sortedQuery = query ? '?' + query.split('&').sort().join('&') : '';
  const bodyStr = body ? JSON.stringify(body) : '';
  const s = ACCESS_ID + token + t + '' + [method, sha256(bodyStr), '', urlPath + sortedQuery].join('\n');
  const res = await axios({
    method, url: `${BASE_URL}${path}`,
    headers: {
      client_id: ACCESS_ID, access_token: token, sign: hmac(s),
      t, sign_method: 'HMAC-SHA256', nonce: '', 'Content-Type': 'application/json',
    },
    data: body || undefined,
  });
  return res.data;
}

app.get('/', (req, res) => res.json({ message: 'iHome API online' }));

app.get('/devices', async (req, res) => {
  try {
    const statusResults = await Promise.all(
      CUSTOM_DEVICES.map(async d => {
        try {
          const s = await tuyaRequest('GET', `/v1.0/iot-03/devices/${d.id}/status`);
          const statusMap = {};
          (s?.result || []).forEach(item => { statusMap[item.code] = item.value; });
          return { id: d.id, name: d.name, category_name: 'Switch', room: d.room, online: true, isControllable: true, switch_1: statusMap.switch_1 === true };
        } catch(e) {
          return { id: d.id, name: d.name, category_name: 'Switch', room: d.room, online: false, isControllable: true, switch_1: false };
        }
      })
    );

    const data = await tuyaRequest('GET', '/v1.3/iot-03/devices?source_type=tuyaUser&source_id=az1673988732280coKKP&size=50');
    const tuyaList = (data?.result?.list || []).filter(d => !CUSTOM_DEVICES.find(c => c.id === d.id));
    const list = [...statusResults, ...tuyaList];
    res.json({ result: { list }, success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/devices/:id/command', async (req, res) => {
  try {
    const { commands } = req.body;
    const data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${req.params.id}/commands`, { commands });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/devices/:id/status', async (req, res) => {
  try {
    const data = await tuyaRequest('GET', `/v1.0/iot-03/devices/${req.params.id}/status`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`iHome API rodando em http://localhost:${PORT}`));