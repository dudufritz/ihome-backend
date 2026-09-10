# Requisitos

## Requisitos funcionais

### Conta e acesso

| ID | Requisito | Prioridade |
|---|---|---|
| RF01 | O sistema deve permitir criar conta com e-mail, senha, nome, CPF e telefone | Alta |
| RF02 | O sistema deve autenticar por e-mail e senha, devolvendo um token de acesso | Alta |
| RF03 | O sistema deve renovar a sessão automaticamente, sem pedir a senha de novo | Alta |
| RF04 | O sistema deve permitir redefinir a senha por link enviado ao e-mail | Alta |
| RF05 | O sistema deve confirmar o endereço de e-mail do usuário | Média |
| RF06 | O sistema deve permitir encerrar a sessão de um dispositivo específico | Média |

### Dispositivos

| ID | Requisito | Prioridade |
|---|---|---|
| RF07 | O usuário deve cadastrar as próprias credenciais da conta Tuya | Alta |
| RF08 | O sistema deve listar todos os dispositivos existentes na conta Tuya do usuário | Alta |
| RF09 | O usuário deve escolher quais dispositivos traz para o iHome, com nome e cômodo | Alta |
| RF10 | O sistema deve exibir o estado atual (ligado/desligado, online/offline) de cada dispositivo | Alta |
| RF11 | O usuário deve ligar e desligar dispositivos pela interface | Alta |
| RF12 | O usuário deve remover um dispositivo do iHome sem afetá-lo na conta Tuya | Média |

### Compartilhamento

| ID | Requisito | Prioridade |
|---|---|---|
| RF13 | O dono deve convidar outra pessoa por e-mail para acessar a casa | Alta |
| RF14 | O convite deve oferecer dois níveis: apenas visualizar ou também controlar | Alta |
| RF15 | O convite só passa a valer depois de aceito pelo convidado | Alta |
| RF16 | O convidado deve ver os dispositivos da casa compartilhada junto aos seus | Alta |
| RF17 | O dono deve revogar o acesso de um convidado a qualquer momento | Alta |
| RF18 | O convidado deve poder sair da casa por conta própria | Média |

### Assistente e automação

| ID | Requisito | Prioridade |
|---|---|---|
| RF19 | O usuário deve controlar dispositivos por comando em linguagem natural | Alta |
| RF20 | O assistente deve ligar ou desligar todos os dispositivos de uma vez | Média |
| RF21 | O assistente deve criar rotinas agendadas por horário | Média |
| RF22 | O sistema deve executar as rotinas agendadas automaticamente | Alta |
| RF23 | O usuário deve consultar e excluir as rotinas criadas | Média |

### Monitoramento e auditoria

| ID | Requisito | Prioridade |
|---|---|---|
| RF24 | O sistema deve detectar quando um dispositivo fica offline ou volta | Alta |
| RF25 | O sistema deve notificar o usuário por push nessas transições | Média |
| RF26 | O sistema deve registrar cada comando enviado a dispositivos, com autor, horário e resultado | Alta |
| RF27 | O dono da casa deve ver todas as ações ocorridas nela, inclusive as de convidados | Alta |
| RF28 | O registro deve incluir as tentativas negadas por falta de permissão | Alta |
| RF29 | O registro deve ser filtrável por usuário, resultado, período e texto livre | Média |

---

## Requisitos não funcionais

### Segurança

| ID | Requisito |
|---|---|
| RNF01 | Senhas armazenadas com bcrypt, nunca em texto puro ou com hash reversível |
| RNF02 | Segredos da conta Tuya cifrados em repouso com AES-256-GCM |
| RNF03 | Toda comunicação por HTTPS |
| RNF04 | Um usuário nunca deve acessar dados de outro (isolamento multi-inquilino) |
| RNF05 | Access token com validade máxima de 15 minutos |
| RNF06 | Refresh token revogável, rotacionado a cada uso, com detecção de reuso |
| RNF07 | Login e recuperação de senha não devem revelar quais e-mails têm conta |
| RNF08 | Toda consulta ao banco deve usar parâmetros, nunca concatenação de strings |

### Qualidade

| ID | Requisito |
|---|---|
| RNF09 | Cobertura de testes de no mínimo 75% no backend e 25% no frontend |
| RNF10 | Análise estática executada a cada push, com portão de qualidade |
| RNF11 | Código organizado em camadas, com separação de responsabilidades |
| RNF12 | Pipeline que impeça publicar código que reprovou nos testes |

### Operação

| ID | Requisito |
|---|---|
| RNF13 | Aplicação hospedada em nuvem, acessível publicamente e estável |
| RNF14 | Monitoramento de desempenho e erros em produção |
| RNF15 | Deploy automatizado, sem intervenção manual por SSH ou FTP |
| RNF16 | Registro de auditoria com retenção de 90 dias |

### Usabilidade

| ID | Requisito |
|---|---|
| RNF17 | Interface responsiva, utilizável em celular e desktop |
| RNF18 | Instalável como PWA, sem loja de aplicativos |
| RNF19 | Funcionamento parcial offline, com cache do Service Worker |
| RNF20 | Feedback visual de carregamento, erro e confirmação em toda ação |

---

## Casos de uso

### UC01 — Controlar um dispositivo

**Ator:** Usuário autenticado (dono ou convidado com permissão de controle)
**Pré-condição:** Credenciais Tuya cadastradas e ao menos um dispositivo adicionado

1. O usuário abre a tela de Dispositivos.
2. O sistema exibe cada dispositivo com o estado atual.
3. O usuário aciona o interruptor de um dispositivo.
4. O sistema verifica a permissão do usuário sobre aquela casa.
5. O sistema assina e envia o comando à API da Tuya.
6. O sistema registra a ação na auditoria.
7. A interface reflete o novo estado.

**Fluxo alternativo 4a — sem permissão:** o sistema recusa com 403, **registra a tentativa negada** e informa o usuário.
**Fluxo alternativo 5a — Tuya indisponível:** o sistema registra o erro na auditoria e informa que o dispositivo não respondeu.

---

### UC02 — Compartilhar a casa

**Ator:** Dono da casa

1. O dono acessa Configurações → Compartilhamento.
2. Informa o e-mail do convidado e escolhe o nível de permissão.
3. O sistema valida o e-mail e gera um token de convite de 32 bytes.
4. O sistema grava o convite com status `pending` e envia o e-mail.
5. O convidado clica em "Aceitar" no e-mail.
6. O sistema muda o status para `accepted`.
7. Os dispositivos da casa passam a aparecer para o convidado.

**Regra:** enquanto o status for `pending`, o convidado **não tem acesso algum**.
**Fluxo alternativo 5a — recusa:** o convite é excluído.
**Fluxo alternativo 3a — e-mail inválido ou o próprio:** o sistema recusa com 400.

---

### UC03 — Comandar por linguagem natural

**Ator:** Usuário autenticado

1. O usuário digita "apaga a luz da sala" no assistente.
2. O sistema monta um prompt com a lista de dispositivos do usuário.
3. O Gemini devolve a intenção estruturada em JSON.
4. **O sistema confere se o identificador devolvido pertence de fato ao usuário.**
5. O sistema envia o comando à Tuya e registra na auditoria.
6. O assistente responde com a confirmação em linguagem natural.

**Fluxo alternativo 4a — identificador desconhecido:** o sistema não executa nada e pede que o usuário repita o nome. É a barreira contra alucinação do modelo e contra instruções maliciosas embutidas no nome de um dispositivo.

---

### UC04 — Consultar a auditoria

**Ator:** Dono da casa

1. O dono acessa a tela de Auditoria.
2. O sistema lista as ações ocorridas na casa dele e as ações que ele próprio executou em outras casas.
3. Cada registro mostra a ação, o dispositivo, o autor, data e hora completas, o resultado e o IP de origem.
4. O dono pode filtrar por usuário, resultado, período ou texto livre.

**Regra de visibilidade:** os filtros só podem restringir o conjunto, nunca ampliá-lo. Não existe parâmetro capaz de fazer alguém enxergar a casa de um terceiro.

---

### UC05 — Ser avisado de queda de dispositivo

**Ator:** Sistema (rotina automática)

1. A cada 5 minutos, o sistema consulta o estado de todos os dispositivos de todos os usuários.
2. Compara com o último estado conhecido, guardado em cache.
3. Havendo **transição** (ficou offline, ou voltou), grava um alerta e envia notificação push.
4. Atualiza o cache.

**Regra:** o alerta é disparado pela transição, não pelo estado. Sem isso, um dispositivo desligado da tomada geraria um alerta a cada 5 minutos, indefinidamente.
