/**
 * services/account.service.js — Exclusão definitiva da conta.
 *
 * POR QUE EXISTE
 * --------------
 * A LGPD (art. 18, VI) dá ao titular o direito de pedir a eliminação dos
 * próprios dados. Sem esta função, a única forma de sair do iHome seria pedir
 * por e-mail e alguém apagar à mão no banco — o que, na prática, quer dizer
 * que a conta nunca seria apagada.
 *
 * POR QUE TUDO NUMA TRANSAÇÃO
 * ---------------------------
 * Os dados do usuário estão espalhados por dez tabelas. Se a exclusão parasse
 * no meio (queda de rede, banco reiniciando), sobraria uma conta pela metade:
 * por exemplo, o usuário apagado mas as credenciais Tuya ainda no banco — e
 * o monitor continuaria consultando a casa de alguém que pediu para sair.
 *
 * Com BEGIN/COMMIT, ou as dez instruções acontecem, ou nenhuma acontece.
 *
 * POR QUE A MAIORIA DAS TABELAS É APAGADA À MÃO
 * ---------------------------------------------
 * Só `refresh_tokens` e `auth_tokens` têm chave estrangeira para `users` com
 * ON DELETE CASCADE. As outras tabelas ligam o usuário pelo E-MAIL, sem chave
 * estrangeira (ver db/schema.js) — então apagar a linha de `users` não as
 * alcança. Cada uma precisa da própria instrução.
 */
const { pool } = require('../config/database');

/**
 * Marca usada no lugar do e-mail nos registros de auditoria que pertencem
 * à casa de OUTRA pessoa. Ver a explicação no passo 9.
 */
const AUTOR_EXCLUIDO = 'conta-excluida';

/**
 * Apaga a conta e todos os dados ligados a ela.
 *
 * @param {object} user  Linha da tabela `users` (precisa de `id` e `email`).
 */
async function excluirConta(user) {
  // Uma conexão só, emprestada do pool, para todas as instruções. A transação
  // vale por CONEXÃO: se cada query fosse para uma conexão diferente do pool,
  // o BEGIN de uma não protegeria as outras.
  const client = await pool.connect();
  const email = user.email;

  try {
    await client.query('BEGIN');

    // 1-4. A casa em si: rotinas, alertas, último estado e os aparelhos.
    await client.query('DELETE FROM user_schedules WHERE user_email = $1', [email]);
    await client.query('DELETE FROM user_alerts WHERE user_email = $1', [email]);
    await client.query('DELETE FROM device_status_cache WHERE user_email = $1', [email]);
    await client.query('DELETE FROM user_devices WHERE user_email = $1', [email]);

    // 5. Credenciais da Tuya. É o dado mais sensível do sistema — com ele se
    // controla a casa física — e o motivo principal de a exclusão ser
    // definitiva, e não um "desativar conta".
    await client.query('DELETE FROM user_tuya_config WHERE user_email = $1', [email]);

    // 6. Inscrições de notificação. Sem isto, os navegadores da pessoa
    // continuariam recebendo push de uma conta que não existe mais.
    await client.query('DELETE FROM push_subscriptions WHERE user_email = $1', [email]);

    // 7. Compartilhamentos nos DOIS sentidos: as casas que ela abriu para
    // outros (os convidados perdem o acesso, já que a casa deixou de existir)
    // e as casas de outros onde ela era convidada.
    await client.query(
      'DELETE FROM home_shares WHERE owner_email = $1 OR guest_email = $1',
      [email]
    );

    // 8. Auditoria da PRÓPRIA casa: some junto com ela.
    await client.query('DELETE FROM audit_log WHERE home_owner_email = $1', [email]);

    // 9. Auditoria na casa de OUTRA pessoa: anonimizada, não apagada.
    //
    // Se a pessoa era convidada na casa do João e ligou a luz da sala, aquele
    // registro pertence ao histórico do João — é a casa dele, e ele tem
    // interesse legítimo em saber que a luz foi ligada. Apagar a linha
    // abriria um buraco no histórico de quem não pediu exclusão nenhuma.
    //
    // O que é dado pessoal de quem saiu — o e-mail, o IP e o navegador — sai
    // da linha. O fato ("alguém ligou a luz às 20h") permanece.
    await client.query(
      `UPDATE audit_log
          SET actor_email = $2, ip_address = NULL, user_agent = NULL
        WHERE actor_email = $1`,
      [email, AUTOR_EXCLUIDO]
    );

    // 10. A conta. O CASCADE leva junto refresh_tokens e auth_tokens — e,
    // com os refresh tokens, todas as sessões abertas em outros aparelhos.
    await client.query('DELETE FROM users WHERE id = $1', [user.id]);

    await client.query('COMMIT');
  } catch (erro) {
    // Qualquer falha desfaz TUDO. Melhor a conta inteira de pé, e o usuário
    // tentando de novo, do que uma conta pela metade.
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    // Devolve a conexão ao pool em qualquer desfecho. Esquecer isto vazaria
    // uma das 10 conexões a cada falha, até o app parar de responder.
    client.release();
  }
}

module.exports = { excluirConta, AUTOR_EXCLUIDO };
