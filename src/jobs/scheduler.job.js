/**
 * jobs/scheduler.job.js — Execução das rotinas agendadas.
 *
 * Roda uma vez por minuto. Formata o horário atual como "HH:MM" e compara com
 * on_time/off_time gravados no mesmo formato — comparação de texto, simples e
 * sem dependência de biblioteca de datas.
 *
 * Limitação conhecida e assumida: o horário é o do relógio do SERVIDOR. Com o
 * app implantado em região brasileira isso coincide com o do usuário. Uma
 * evolução natural seria guardar o fuso de cada usuário e converter aqui.
 *
 * AS ROTINAS ENTRAM NA AUDITORIA
 *
 * Antes, o único vestígio de uma rotina executada era um `console.log`. Isso
 * abria um buraco no centro do projeto: a luz do quarto acendia às 22h e o
 * registro de auditoria — a tela que existe para responder "quem mexeu no
 * quê" — não mostrava nada. Quem olhasse concluiria que ninguém tinha mexido.
 *
 * Pior: o `console.log` imprimia "Ligou" mesmo quando o comando falhava, pois
 * o erro era engolido por um `.catch` e a linha seguinte escrevia sucesso de
 * qualquer jeito. Ou seja, o único registro que existia também mentia.
 *
 * A correção veio do review do @pdrollucas no PR #2 sobre `console.log`. O
 * comentário era sobre outra linha, mas o raciocínio é o mesmo: log de
 * console não é registro. Quem precisa da informação não lê o terminal do
 * servidor, e um log não diferencia o que aconteceu do que se tentou fazer.
 */
const { pool } = require('../config/database');
const { tuyaRequest } = require('../services/tuya.service');
const { decrypt } = require('../services/crypto.service');
const { recordAudit, describeCommands } = require('../services/audit.service');

/** Devolve o horário atual como "HH:MM", com zero à esquerda. */
function horaAtual() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Envia o comando e registra o desfecho REAL na auditoria.
 *
 * O try/catch existe para que o resultado gravado seja o que de fato
 * aconteceu: `success` só quando a Tuya aceitou, `error` com a mensagem dela
 * quando não. Uma falha aqui não interrompe as outras rotinas do mesmo minuto.
 *
 * `req` vai como null: ninguém fez a requisição. A auditoria grava ator (o
 * dono da rotina) e ação, e deixa IP e user-agent vazios — que é a leitura
 * correta de "partiu do servidor", não de um navegador.
 *
 * @param {object} s linha do JOIN entre user_schedules e as credenciais
 * @param {boolean} estado true para ligar, false para desligar
 */
async function acionar(s, estado) {
  const commands = [{ code: 'switch_1', value: estado }];
  const dadosBase = {
    homeOwnerEmail: s.user_email,
    actorEmail: s.user_email,
    action: 'device.command',
    deviceId: s.device_id,
    deviceName: s.device_name,
  };

  try {
    await tuyaRequest(
      'POST', `/v1.0/iot-03/devices/${s.device_id}/commands`,
      s.tuya_access_id, s.secretDecifrado, s.tuya_base_url,
      { commands }
    );
    await recordAudit(null, {
      ...dadosBase,
      details: {
        commands,
        summary: describeCommands(commands),
        // `via` distingue, na tela, o que a pessoa fez do que o sistema fez
        // sozinho. Sem isso, uma rotina noturna pareceria alguém acordado
        // mexendo no app às 3h — exatamente o falso alarme que a auditoria
        // deveria evitar.
        via: 'rotina',
        room: s.room || null,
        horario: estado ? s.on_time : s.off_time,
      },
      result: 'success',
    });
  } catch (err) {
    await recordAudit(null, {
      ...dadosBase,
      details: {
        commands,
        summary: describeCommands(commands),
        via: 'rotina',
        room: s.room || null,
        horario: estado ? s.on_time : s.off_time,
      },
      result: 'error',
      errorMessage: err.message,
    });
  }
}

async function runSchedules() {
  try {
    const currentTime = horaAtual();

    // O JOIN traz as credenciais junto para não precisar de uma consulta por
    // agendamento. tuya_secret vem cifrado e é decifrado logo abaixo.
    //
    // O LEFT JOIN em user_devices busca o cômodo. É LEFT e não INNER porque
    // uma rotina precisa continuar funcionando mesmo se o dispositivo tiver
    // sido removido da lista do usuário — nesse caso o cômodo fica nulo, e
    // isso é uma informação, não um erro.
    const result = await pool.query(
      `SELECT s.*, c.tuya_access_id, c.tuya_secret, c.tuya_base_url, d.room
       FROM user_schedules s
       JOIN user_tuya_config c ON s.user_email = c.user_email
       LEFT JOIN user_devices d
              ON d.user_email = s.user_email AND d.tuya_id = s.device_id
       WHERE s.active = true`
    );

    for (const s of result.rows) {
      const ligaAgora = s.on_time === currentTime;
      const desligaAgora = s.off_time === currentTime;
      if (!ligaAgora && !desligaAgora) continue; // nada a fazer neste minuto

      try {
        s.secretDecifrado = decrypt(s.tuya_secret);
      } catch (e) {
        // Credencial ilegível: registra como falha da rotina em vez de sumir
        // num log. É o caso de quem trocou a chave de criptografia do servidor
        // e não sabe por que as rotinas pararam.
        await recordAudit(null, {
          homeOwnerEmail: s.user_email,
          actorEmail: s.user_email,
          action: 'device.command',
          deviceId: s.device_id,
          deviceName: s.device_name,
          details: { via: 'rotina', summary: 'Rotina não executada', room: s.room || null },
          result: 'error',
          errorMessage: 'Credencial Tuya ilegível: não foi possível decifrar o segredo.',
        });
        continue;
      }

      if (ligaAgora) await acionar(s, true);
      if (desligaAgora) await acionar(s, false);
    }
  } catch (err) {
    // Erro na própria consulta: não há rotina específica a que atribuir a
    // falha, então este é o único caso em que console é o lugar certo.
    console.error('Cron erro:', err.message);
  }
}

module.exports = { runSchedules, horaAtual, acionar };
