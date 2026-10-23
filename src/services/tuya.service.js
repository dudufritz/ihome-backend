/**
 * services/tuya.service.js — Comunicação com a nuvem Tuya IoT.
 *
 * A Tuya não usa uma API key simples: cada requisição precisa de uma
 * ASSINATURA HMAC-SHA256 que prova que quem chamou conhece o secret, sem
 * jamais transmitir o secret pela rede. A assinatura cobre o método, o corpo,
 * o caminho e o horário — então ela não pode ser reaproveitada em outra
 * chamada nem repetida muito tempo depois.
 */
const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../config/database');
const { decrypt } = require('./crypto.service');
const { normalizeEmail } = require('../utils/email');

/** Assina uma string com HMAC-SHA256; a Tuya exige o resultado em MAIÚSCULAS. */
function makeSign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase();
}

/** SHA-256 do corpo da requisição (string vazia quando não há corpo). */
function sha256(str) {
  return crypto.createHash('sha256').update(str || '').digest('hex');
}

/**
 * Cache de tokens de acesso da Tuya, indexado pelo access_id.
 * Cada token vale ~2 horas; sem cache, gastaríamos uma chamada de
 * autenticação antes de cada operação.
 */
const tokenCache = {};

/**
 * Nomes dos centros de dados da Tuya, para a mensagem de erro dizer em qual
 * servidor a pergunta foi feita — e não apenas que ela falhou.
 */
const REGIOES = {
  'https://openapi.tuyaus.com': 'Western America',
  'https://openapi-ueaz.tuyaus.com': 'Eastern America',
  'https://openapi.tuyaeu.com': 'Central Europe',
  'https://openapi-weaz.tuyaeu.com': 'Western Europe',
  'https://openapi.tuyacn.com': 'China',
  'https://openapi.tuyain.com': 'India',
};

/**
 * Traduz a resposta de erro da Tuya para uma frase acionável.
 *
 * POR QUE ISTO EXISTE: antes, a falha subia como o JSON cru da Tuya —
 * `{"code":2009,"msg":"clientId is invalid","success":false}` — direto na tela
 * do usuário. Além de ilegível, induzia ao erro: "clientId is invalid" parece
 * credencial errada, quando na prática quase sempre significa que o Access ID
 * está certo mas foi perguntado no centro de dados errado. A pessoa ficava
 * regerando credenciais que já funcionavam.
 *
 * Os códigos vêm da documentação da Tuya. Quando não reconhecemos um, ainda
 * devolvemos a mensagem original — perder informação seria pior que mostrá-la.
 */
function explicarErroTuya(resposta, baseUrl) {
  const regiao = REGIOES[baseUrl] || baseUrl;
  const codigo = resposta?.code;
  const original = resposta?.msg || JSON.stringify(resposta);

  const explicacoes = {
    // O Access ID não existe NESTE centro de dados. Cada projeto Tuya vive em
    // um só, e o ID não é reconhecido fora dele.
    2009: `O Access ID não foi reconhecido no servidor "${regiao}". `
        + 'Confira em platform.tuya.com → Cloud → Development → seu projeto → Overview '
        + 'qual é o Data Center, e selecione a mesma região em Configurações.',
    // Assinatura inválida: o Access ID existe, o segredo não confere.
    1004: `O Access Secret não confere com o Access ID no servidor "${regiao}". `
        + 'Copie os dois novamente do painel da Tuya, sem espaços nas pontas.',
    // Permissão de API não habilitada no projeto.
    1106: 'O projeto na Tuya não tem permissão para esta API. '
        + 'Em platform.tuya.com → seu projeto → Service API, habilite '
        + '"IoT Core" e "Authorization Token Management".',
    // Nenhum dispositivo vinculado — não é erro de credencial.
    1100: 'Nenhum dispositivo vinculado ao projeto. '
        + 'Em platform.tuya.com → seu projeto → Devices → Link Tuya App Account, '
        + 'escaneie o QR code pelo app Smart Life.',
    // Projeto sem assinatura ativa para esta API.
    //
    // É o código que a Tuya devolve quando o período de avaliação do projeto
    // de nuvem termina. As credenciais continuam válidas e o vínculo com o
    // Smart Life continua lá: o que caducou foi a autorização para chamar a
    // API. Vale separar dos demais porque a ação é outra — não adianta
    // regerar credencial nem refazer o vínculo.
    28841002: 'O projeto na Tuya não está autorizado a chamar esta API. '
        + 'Normalmente é o período de avaliação do projeto de nuvem que venceu. '
        + 'Em platform.tuya.com → Cloud → Development → seu projeto → Service API, '
        + 'confira a validade de "IoT Core" e renove a avaliação se estiver expirada.',
    // Avaliação válida, mas a cota do pacote de recursos acabou.
    //
    // Distinto do 28841002, e a confusão entre os dois custa tempo: ali o
    // projeto perdeu a autorização; aqui ele a tem, e o que acabou foi o
    // saldo do "Cloud Develop Base Resource Trial" — uma cota em dólares que
    // toda chamada consome e que se renova mensalmente. Estender a avaliação
    // não recarrega essa cota.
    28841004: 'A cota do pacote de recursos do IoT Core se esgotou. '
        + 'A avaliação do projeto pode estar válida e ainda assim as chamadas '
        + 'serem recusadas: são coisas separadas. '
        + 'Em platform.tuya.com → Cloud → Development → seu projeto → Service API → '
        + 'IoT Core, veja "Cloud Develop Base Resource Trial" — se estiver '
        + 'Suspended, é preciso aguardar a renovação mensal da cota ou assinar '
        + 'um novo pacote de recursos.',
    // A allowlist de IP do projeto recusou a origem da chamada.
    //
    // Vale a mensagem explícita porque o sintoma engana: a falha aparece na
    // autenticação e parece credencial errada. O endereço que a Tuya recusou
    // vem na própria resposta, e num App Service ele muda sozinho — o plano
    // tem dezenas de IPs de saída possíveis, acima do limite de 20 entradas
    // que a allowlist aceita por data center.
    1114: 'A lista de IPs autorizados do projeto Tuya recusou este endereço. '
        + 'Em platform.tuya.com → Cloud → Development → seu projeto → Overview, '
        + 'veja "Cloud Authorization IP Allowlist": ou cadastre o IP recusado, '
        + 'ou desligue a lista. Hospedagens em nuvem costumam sair por vários '
        + 'endereços diferentes, o que torna a lista pouco prática.',
    // Token inválido ou expirado do lado da Tuya.
    1010: 'O token de acesso expirou do lado da Tuya. '
        + 'Tente novamente; se persistir, confira o Access Secret.',
  };

  const explicacao = explicacoes[codigo];
  return explicacao
    ? `${explicacao} (Tuya: ${codigo} — ${original})`
    : `Falha ao autenticar na Tuya no servidor "${regiao}": ${original} (código ${codigo})`;
}

/**
 * Obtém um token de acesso, reaproveitando o do cache quando ainda válido.
 * Guardamos a expiração com 60s de margem para nunca usar um token que
 * vence no meio do caminho.
 */
async function getToken(accessId, accessSecret, baseUrl) {
  const cached = tokenCache[accessId];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const t = Date.now().toString(); // timestamp em milissegundos
  // String a assinar no fluxo SEM token: accessId + timestamp + resumo da requisição
  const s = accessId + t + ['GET', sha256(''), '', '/v1.0/token?grant_type=1'].join('\n');

  const res = await axios.get(`${baseUrl}/v1.0/token?grant_type=1`, {
    headers: {
      client_id: accessId,
      sign: makeSign(accessSecret, s),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
    },
  });
  if (!res.data.success) {
    throw new Error(explicarErroTuya(res.data, baseUrl));
  }

  tokenCache[accessId] = {
    token: res.data.result.access_token,
    expiry: Date.now() + (res.data.result.expire_time * 1000) - 60000, // margem de 1 min
  };
  return tokenCache[accessId].token;
}

/**
 * Executa uma requisição autenticada na API da Tuya.
 *
 * Detalhe crítico da assinatura: os parâmetros de query precisam estar em
 * ordem alfabética, senão a assinatura calculada aqui não bate com a
 * calculada do lado da Tuya e a chamada é rejeitada.
 */
async function tuyaRequest(method, path, accessId, accessSecret, baseUrl, body = null) {
  const token = await getToken(accessId, accessSecret, baseUrl);
  const t = Date.now().toString();

  const [urlPath, query] = path.split('?');
  const sortedQuery = query ? '?' + query.split('&').sort().join('&') : '';
  const bodyStr = body ? JSON.stringify(body) : '';

  // String a assinar no fluxo COM token: accessId + token + timestamp + resumo
  const s = accessId + token + t + [method, sha256(bodyStr), '', urlPath + sortedQuery].join('\n');

  const res = await axios({
    method,
    url: `${baseUrl}${path}`,
    headers: {
      client_id: accessId,
      access_token: token,
      sign: makeSign(accessSecret, s),
      t,
      sign_method: 'HMAC-SHA256',
      nonce: '',
      'Content-Type': 'application/json',
    },
    data: body || undefined,
  });

  // SEM log de sucesso aqui.
  //
  // Havia um `console.log` por chamada. Este é o caminho de TODA conversa com
  // a Tuya: o app consulta o estado dos dispositivos a cada 30 segundos e o
  // monitor varre todos a cada 5 minutos. Com 38 aparelhos, isso passava de
  // mil linhas "ok" por hora — o suficiente para esconder as mensagens de erro
  // que realmente precisam ser vistas no log do App Service.
  //
  // Mesma conclusão do review do @pdrollucas no PR #2: log de caminho feliz
  // atrapalha em vez de informar. As falhas continuam aparecendo, via
  // explicarErroTuya, e as ações ficam registradas na auditoria.
  return res.data;
}

/**
 * Busca as credenciais Tuya de um usuário e já devolve o segredo DECIFRADO,
 * pronto para assinar requisições.
 *
 * Este é o único ponto do sistema que decifra o segredo. Manter a decifragem
 * concentrada aqui garante que nenhuma rota manipule o valor cifrado por engano.
 */
async function getUserTuya(email) {
  const alvo = normalizeEmail(email);
  const result = await pool.query('SELECT * FROM user_tuya_config WHERE user_email = $1', [alvo]);
  if (result.rows.length === 0) {
    throw new Error('Credenciais Tuya não configuradas. Acesse Configurações para cadastrá-las.');
  }
  const config = result.rows[0];
  // decrypt() devolve o valor intacto se a linha for antiga (texto puro),
  // o que permite a migração acontecer sem downtime.
  return { ...config, tuya_secret: decrypt(config.tuya_secret) };
}

/**
 * Quantos dispositivos cabem numa consulta de estado em lote.
 * É o teto da própria API da Tuya; acima disso a chamada é recusada.
 */
const LOTE_MAXIMO = 20;

/**
 * Consulta o estado de VÁRIOS dispositivos de uma vez.
 *
 * POR QUE ISTO EXISTE: a leitura era uma chamada por dispositivo. Numa casa
 * com 20 aparelhos, cada atualização da tela custava 20 chamadas, e a tela se
 * atualiza sozinha a cada 30 segundos — mais o monitor de conectividade, que
 * varre tudo de novo em segundo plano. São dezenas de milhares de chamadas por
 * dia para mostrar a mesma casa.
 *
 * Isso não é só desperdício: a avaliação gratuita da Tuya trabalha com uma
 * COTA MENSAL de chamadas, e esse volume a consome em poucos dias. Quando ela
 * acaba, a API para de responder e o app inteiro parece quebrado — foi
 * exatamente o que aconteceu em outubro de 2026.
 *
 * Uma chamada em lote traz até 20 aparelhos, o que reduz o consumo na mesma
 * proporção.
 *
 * O que devolve: um Map de `tuya_id` → objeto `{ código: valor }`. Quem não
 * aparecer no Map é dispositivo que a Tuya não soube responder — a leitura
 * de "online" continua sendo a ausência ou presença da resposta, igual a
 * antes, para não mudar o comportamento dos alertas de queda.
 */
async function buscarStatusEmLote(ids, accessId, accessSecret, baseUrl) {
  const porDispositivo = new Map();

  for (let i = 0; i < ids.length; i += LOTE_MAXIMO) {
    const fatia = ids.slice(i, i + LOTE_MAXIMO);
    const resposta = await tuyaRequest(
      'GET',
      `/v1.0/iot-03/devices/status?device_ids=${fatia.join(',')}`,
      accessId, accessSecret, baseUrl
    );

    // Recusa da Tuya (cota, permissão, allowlist) não é "nenhum dispositivo":
    // precisa subir como erro para quem chamou decidir o que fazer.
    if (resposta?.success === false) {
      throw new Error(explicarErroTuya(resposta, baseUrl));
    }

    for (const item of resposta?.result || []) {
      const mapa = {};
      (item?.status || []).forEach(({ code, value }) => { mapa[code] = value; });
      porDispositivo.set(item.id, mapa);
    }
  }

  return porDispositivo;
}

module.exports = {
  makeSign, sha256, getToken, tuyaRequest, getUserTuya, tokenCache,
  explicarErroTuya, REGIOES, buscarStatusEmLote, LOTE_MAXIMO,
};
