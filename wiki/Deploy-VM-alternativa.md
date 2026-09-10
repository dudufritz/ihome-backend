# iHome numa VM Azure — alternativa não utilizada

> ℹ️ **Este caminho não está em uso**, mas *não* por impossibilidade.
>
> A primeira tentativa de criar a VM falhou com `Current Limit (Total VMs): 0`
> em **Brazil South**. Concluí, erradamente, que assinaturas Azure for Students
> não permitem criar computação.
>
> **A conclusão estava errada.** A cota de computação do Azure é **por região**.
> A mesma assinatura criou recursos normalmente em **West Central US**. O que
> faltava era cota naquela região específica, não permissão na assinatura.
>
> O projeto acabou em App Service (ver [../DEPLOY.md](../DEPLOY.md)) porque foi
> o que subiu primeiro. Este documento fica como alternativa avaliada — e como
> registro de que um erro de diagnóstico custou uma migração inteira para outra
> nuvem antes de a causa real aparecer.
>
> **A lição:** `Current Limit: 0` em uma região não diz nada sobre as outras.
> Antes de trocar de provedor, vale testar outra região.

Guia do deploy em máquina virtual: tudo (banco, API, frontend, HTTPS) numa única VM Linux, com atualização automática e **sem SSH no pipeline**.

---

## 1. Por que VM, e não PaaS

O `DEPLOY.md` descreve o caminho gerenciado (App Service + PostgreSQL Flexible + Static Web Apps). Ele funciona e dá menos manutenção. A VM foi escolhida por um motivo concreto: **custo**.

| Arranjo | Mensal | US$ 100 de crédito duram |
|---|---|---|
| PaaS em Brazil South | ~US$ 50 | 2 meses |
| PaaS em East US | ~US$ 33 | 3 meses |
| **VM B1ms em East US** | **~US$ 17** | **~6 meses** |

São 3,5 meses até o Demo Day. O arranjo gerenciado em Brazil South não cobre o prazo; a VM cobre com folga.

Sobre a região: **Brazil South custa cerca de 60% mais** que East US. Para automação residencial, os ~100 ms adicionais de latência não são perceptíveis — o gargalo é a nuvem da Tuya, não a distância até o servidor.

### O que se ganha

- **Custo** — um terço do arranjo gerenciado.
- **Controle demonstrável** — a infraestrutura inteira está versionada em `cloud-init.yaml` e `docker-compose.prod.yml`. É a resposta direta à ressalva do Playbook sobre *"serviços de cloud que ocultam infraestrutura sem domínio técnico sobre o ambiente"*.
- **Origem única** — frontend e API no mesmo domínio elimina CORS por completo.
- **Rate limiting coerente** — uma instância só, então o contador em memória não é mais uma limitação.

### O que se perde

- **Backup gerenciado** — o PostgreSQL Flexible fazia sozinho. Aqui há um `pg_dump` diário via systemd timer (`backup.sh`), com retenção de 14 dias e verificação de tamanho.
- **Atualizações do SO** — resolvido com `unattended-upgrades`, incluindo reinício automático às 5h quando necessário.
- **Ponto único de falha** — se a VM cai, cai tudo. Aceitável para o escopo; o `restart: always` e o serviço systemd garantem que a stack volte após reboot.

---

## 2. Arquitetura

```
                    Internet
                       │
                  :443 │ HTTPS (Let's Encrypt, renovado sozinho)
                       ▼
        ┌──────────────────────────────┐
        │  VM Ubuntu 24.04 · B1ms      │
        │  2 vCPU · 2 GB · 30 GB SSD   │
        │                              │
        │  ┌────────────────────────┐  │
        │  │ web (Caddy)            │  │  ← única porta exposta
        │  │  /      → build React  │  │
        │  │  /api/* → api:3001     │  │
        │  └───────────┬────────────┘  │
        │              │ rede interna  │
        │  ┌───────────▼────────────┐  │
        │  │ api (Node 24)          │  │  ← sem porta pública
        │  └───────────┬────────────┘  │
        │              │               │
        │  ┌───────────▼────────────┐  │
        │  │ db (PostgreSQL 16)     │  │  ← sem porta pública
        │  └────────────────────────┘  │
        │                              │
        │  watchtower → atualiza as    │
        │  imagens sozinho, sem SSH    │
        └──────────────────────────────┘
```

Apenas o Caddy publica portas. O Postgres e a API só são alcançáveis pela rede interna do compose — nem o firewall precisa bloqueá-los, porque não existem do lado de fora.

---

## 3. Provisionamento

### 3.1 Variáveis

```bash
export RG=ihome-rg
export LOCAL=eastus                 # East US: sem o prêmio de Brazil South
export VM=ihome-vm
export DNS=ihome-eduardo            # vira ihome-eduardo.eastus.cloudapp.azure.com
```

O rótulo DNS precisa ser único dentro da região. Se der conflito, escolha outro.

### 3.2 Criar a VM

```bash
az login
az group create --name $RG --location $LOCAL

az vm create \
  --resource-group $RG \
  --name $VM \
  --image Ubuntu2404 \
  --size Standard_B1ms \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-address-dns-name $DNS \
  --public-ip-sku Standard \
  --os-disk-size-gb 30 \
  --custom-data cloud-init.yaml
```

Rode de dentro da pasta `infra/`, onde está o `cloud-init.yaml`.

Sobre `--size Standard_B1ms`: 2 GB de RAM. O B1s, de 1 GB, custa ~US$ 8 a menos por mês, mas Postgres + Node + Caddy nesse espaço entram em swap e ficam instáveis — não é onde economizar às vésperas de uma apresentação.

### 3.3 Abrir as portas

```bash
az vm open-port --resource-group $RG --name $VM --port 80  --priority 1001
az vm open-port --resource-group $RG --name $VM --port 443 --priority 1002
```

O `ufw` dentro da VM já faz o mesmo, mas o Network Security Group do Azure é uma camada anterior: sem esta liberação, o tráfego nem chega à máquina.

### 3.4 Confirmar o cloud-init

O provisionamento leva 3–5 minutos. Para acompanhar:

```bash
ssh azureuser@$DNS.$LOCAL.cloudapp.azure.com
sudo cloud-init status --wait
```

> Este é o **único** uso de SSH em todo o processo, e é administrativo — não é deploy. O deploy acontece pelo registry, como descrito na seção 5.

---

## 4. Configurar os segredos

Ainda conectado à VM:

```bash
sudo cp /opt/ihome/.env.example /opt/ihome/.env
sudo nano /opt/ihome/.env
```

Preencha:

```bash
DOMINIO=ihome-eduardo.eastus.cloudapp.azure.com
GITHUB_REPO=dudufritz
POSTGRES_USER=ihome
POSTGRES_PASSWORD=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>
GEMINI_API_KEY=<sua chave>
GMAIL_USER=<seu e-mail>
GMAIL_APP_PASSWORD=<senha de app>
```

Gere os três segredos com:

```bash
openssl rand -hex 32
```

> ⚠️ **Guarde `JWT_SECRET` e `ENCRYPTION_KEY` fora da VM.** Trocar a primeira desconecta todos os usuários; perder a segunda torna os segredos Tuya já cifrados **irrecuperáveis**. Um gerenciador de senhas resolve.

Proteja o arquivo e suba a stack:

```bash
sudo chmod 600 /opt/ihome/.env
sudo systemctl start ihome
sudo docker compose -f /opt/ihome/docker-compose.prod.yml ps
```

O Caddy pede o certificado ao Let's Encrypt na primeira subida. Leva de 10 a 60 segundos; se falhar, é quase sempre porque a porta 80 não está acessível de fora.

---

## 5. Deploy: por que não há SSH

O Playbook marca **"Deploy via acesso ssh/ftp" como 🚫 Não Usar** — item de reprovação direta. VM é justamente o ambiente que convida a esse erro. Aqui o fluxo evita SSH por construção:

```
git push origin main
        │
        ▼
GitHub Actions ── testes ── portão de cobertura ── SonarCloud
        │
        ▼
constrói a imagem e publica no GHCR
        │
        ▼  (a VM observa o registry)
Watchtower detecta a tag :latest nova
        │
        ▼
baixa, troca o contêiner e remove a imagem antiga
```

O pipeline **nunca toca na VM**. Ele publica num registry; a máquina converge sozinha, verificando a cada 2 minutos. O deploy é declarativo, não imperativo — e o mesmo mecanismo funcionaria com 1 ou 50 máquinas.

O GHCR (GitHub Container Registry) é gratuito para repositórios públicos, o que ainda dispensa os ~US$ 5/mês do Azure Container Registry.

### Segredos do GitHub Actions

Com esta arquitetura, a lista encolheu bastante:

| Secret | Onde obter |
|---|---|
| `SONAR_TOKEN` | sonarcloud.io → My Account → Security |

Só isso. O `GITHUB_TOKEN` de publicação no GHCR é fornecido automaticamente pelo Actions.

Nas configurações do repositório, marque **Settings → Actions → General → Workflow permissions → Read and write permissions**, senão o push da imagem é recusado.

---

## 6. Verificação

```bash
# API
curl https://ihome-eduardo.eastus.cloudapp.azure.com/api/health
# esperado: {"ok":true,"push":true}

# Frontend
curl -I https://ihome-eduardo.eastus.cloudapp.azure.com
# esperado: HTTP/2 200

# Certificado válido e emissor
echo | openssl s_client -connect ihome-eduardo.eastus.cloudapp.azure.com:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

Checklist funcional, no navegador:

- [ ] criar conta e receber o e-mail de confirmação
- [ ] fazer login e continuar logado após recarregar
- [ ] cadastrar credenciais Tuya e descobrir dispositivos
- [ ] ligar e desligar um dispositivo
- [ ] convidar outro e-mail e aceitar pelo link
- [ ] ver a ação do convidado na tela de Auditoria
- [ ] instalar o PWA pelo navegador do celular (exige o HTTPS, que já está)

---

## 7. Operação

```bash
# Estado da stack
sudo docker compose -f /opt/ihome/docker-compose.prod.yml ps

# Logs ao vivo
sudo docker compose -f /opt/ihome/docker-compose.prod.yml logs -f api

# Backup manual
sudo /opt/ihome/backup.sh

# Backups existentes
ls -lh /opt/ihome/backups/

# Confirmar o agendamento
systemctl list-timers ihome-backup.timer

# Uso de recursos
sudo docker stats --no-stream
```

### Restaurar um backup

```bash
gunzip -c /opt/ihome/backups/ihome-20261201-040000.sql.gz \
  | sudo docker compose -f /opt/ihome/docker-compose.prod.yml exec -T db \
    psql -U ihome -d ihome
```

> Teste a restauração **antes** de precisar dela. Backup que nunca foi restaurado é hipótese, não garantia.

### Voltar a uma versão anterior

```bash
# Lista as tags publicadas: ghcr.io/dudufritz/ihome-backend
sudo docker compose -f /opt/ihome/docker-compose.prod.yml stop watchtower
sudo docker pull ghcr.io/dudufritz/ihome-backend:<SHA_ANTERIOR>
sudo docker tag ghcr.io/dudufritz/ihome-backend:<SHA_ANTERIOR> \
                ghcr.io/dudufritz/ihome-backend:latest
sudo docker compose -f /opt/ihome/docker-compose.prod.yml up -d api
```

Pare o Watchtower antes, senão ele volta para a `:latest` do registry em até 2 minutos.

---

## 8. Custo

| Item | Mensal |
|---|---|
| VM Standard_B1ms (2 vCPU, 2 GB) | ~US$ 15,00 |
| Disco SSD Standard 30 GB | ~US$ 2,00 |
| IP público estático | ~US$ 3,00 |
| GHCR (repositório público) | US$ 0 |
| **Total** | **~US$ 20/mês** |

Com US$ 100 do GitHub Student Pack: **cerca de 5 meses**, cobrindo com folga a entrega de 30/11 e o Demo Day de dezembro.

Para economizar durante o desenvolvimento:

```bash
az vm deallocate --resource-group $RG --name $VM   # para de cobrar a computação
az vm start --resource-group $RG --name $VM        # volta, stack sobe sozinha
```

`deallocate` (e não `stop`) é o que interrompe a cobrança da computação — disco e IP continuam sendo cobrados. O serviço systemd garante que a stack volte no boot.

> Não deixe a VM desalocada perto da entrega. O requisito é *"pública e estável até a divulgação final das notas"*.

---

## 9. Se algo der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Certificado não emite | Porta 80 fechada no NSG | Repetir o `az vm open-port` da porta 80 |
| `502 Bad Gateway` | A API não subiu | `docker compose logs api` — geralmente `.env` incompleto |
| API reinicia em laço | `DATABASE_URL` errada ou banco fora | `docker compose logs db` |
| Login falha com 500 | `JWT_SECRET` ausente | Conferir o `.env` e `systemctl restart ihome` |
| Frontend chama localhost | Imagem construída sem `REACT_APP_API_URL` | O Dockerfile usa `/api` por padrão; reconstruir |
| Site fora após semanas | Disco cheio de logs | Os limites de log já estão no compose; conferir com `df -h` |
| Deploy não chega | Watchtower parado ou imagem privada | `docker logs <watchtower>`; o pacote GHCR precisa ser público |
