# iHome na AWS — servidor 24h

Deploy numa instância EC2: banco, API, frontend e HTTPS numa máquina só, com atualização automática e **sem SSH no pipeline**.

---

## 1. Por que AWS

Não foi a primeira escolha. A ordem real dos fatos:

> ℹ️ **Este documento não está em uso.** O projeto roda em Azure App Service
> (ver [../DEPLOY.md](../DEPLOY.md)). Fica como alternativa avaliada.

| Tentativa | O que aconteceu |
|---|---|
| Azure VM, Brazil South | `Current Limit (Total VMs): 0` |
| Azure App Service, Brazil South | `Microsoft.Web/serverFarms` reprovou na validação |
| **Azure App Service, West Central US** | **Funcionou** |

**A causa era a região, não a assinatura.** Concluí no meio do caminho que contas Azure for Students não permitem criar computação — e estava errado. A cota do Azure é por região: Brazil South estava esgotada, West Central US não. Trocar de região resolveu o que uma migração de nuvem inteira tentava contornar.

### Custo

A AWS **encerrou o free tier de 12 meses em 15 de julho de 2025**. Contas criadas depois disso recebem US$ 100 em créditos, que chegam a US$ 200 ao completar cinco tarefas de integração, válidos por 6 meses.

| Item | Mensal |
|---|---|
| EC2 t3.micro (2 vCPU, 1 GB) | ~US$ 7,60 |
| Volume EBS gp3 30 GB | ~US$ 2,40 |
| IP elástico (associado a instância ativa) | US$ 0 |
| Transferência de saída (dentro de 100 GB) | US$ 0 |
| **Total** | **~US$ 10/mês** |

Com US$ 200 de crédito e 3,5 meses até o Demo Day, sobra folga confortável.

> ⚠️ **1 GB de RAM é apertado** para Postgres + Node + Caddy. A seção 3.4 configura um arquivo de swap de 2 GB, que resolve na prática para uma aplicação com poucos usuários simultâneos. Se preferir margem, o t3.small (2 GB) custa ~US$ 15/mês — ainda dentro do crédito.

---

## 2. Arquitetura

Idêntica à que já estava documentada — só muda o provedor:

```
                    Internet
                       │
                  :443 │ HTTPS (Let's Encrypt, renovado sozinho)
                       ▼
        ┌──────────────────────────────┐
        │  EC2 t3.micro · Ubuntu 24.04 │
        │                              │
        │  ┌────────────────────────┐  │
        │  │ web (Caddy)            │  │  ← única porta exposta
        │  │  /      → build React  │  │
        │  │  /api/* → api:3001     │  │
        │  └───────────┬────────────┘  │
        │  ┌───────────▼────────────┐  │
        │  │ api (Node 24)          │  │  ← sem porta pública
        │  └───────────┬────────────┘  │
        │  ┌───────────▼────────────┐  │
        │  │ db (PostgreSQL 16)     │  │  ← sem porta pública
        │  └────────────────────────┘  │
        │                              │
        │  watchtower → atualiza as    │
        │  imagens sozinho, sem SSH    │
        └──────────────────────────────┘
```

Os arquivos `cloud-init.yaml`, `docker-compose.prod.yml` e `backup.sh` são os mesmos. Nada precisou ser reescrito.

---

## 3. Provisionamento

### 3.1 O problema do domínio — resolva primeiro

A AWS dá um endereço automático no formato `ec2-52-1-2-3.compute-1.amazonaws.com`. **O Let's Encrypt recusa emitir certificado para domínios `amazonaws.com`**, então o HTTPS não funcionaria — e sem HTTPS o PWA não instala no celular.

Duas saídas:

**Grátis — DuckDNS.** Entre em [duckdns.org](https://www.duckdns.org), faça login com o Google e crie o subdomínio `ihome-eduardo`. Você fica com `ihome-eduardo.duckdns.org` e um token. Depois de criar a instância (3.3), aponte o subdomínio para o IP elástico ali mesmo no site.

**~R$ 40/ano — domínio próprio.** Um `.com.br` no [registro.br](https://registro.br) ou um `.app`. Custa pouco e o Playbook lista *"uso de domínio próprio"* como **diferencial** — ou seja, ponto a mais na avaliação. Se puder, vale.

O restante do guia usa `SEU-DOMINIO` como espaço reservado.

### 3.2 Variáveis

```bash
export REGIAO=us-east-1
export NOME=ihome
export DOMINIO=ihome-eduardo.duckdns.org
```

### 3.3 Criar a instância

Com o [AWS CLI](https://aws.amazon.com/cli/) configurado (`aws configure`):

```bash
# Par de chaves para acesso administrativo
aws ec2 create-key-pair --region $REGIAO --key-name $NOME-key \
  --query 'KeyMaterial' --output text > ~/.ssh/$NOME-key.pem
chmod 400 ~/.ssh/$NOME-key.pem

# Grupo de segurança: só 22, 80 e 443
export SG=$(aws ec2 create-security-group --region $REGIAO \
  --group-name $NOME-sg --description "iHome" --query 'GroupId' --output text)

for PORTA in 22 80 443; do
  aws ec2 authorize-security-group-ingress --region $REGIAO \
    --group-id $SG --protocol tcp --port $PORTA --cidr 0.0.0.0/0
done

# Ubuntu 24.04 LTS mais recente
export AMI=$(aws ssm get-parameters --region $REGIAO \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)

# A instância, já com o cloud-init
aws ec2 run-instances --region $REGIAO \
  --image-id $AMI \
  --instance-type t3.micro \
  --key-name $NOME-key \
  --security-group-ids $SG \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --user-data file://cloud-init.yaml \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NOME}]"
```

Rode de dentro da pasta `infra/`, onde está o `cloud-init.yaml`.

### 3.4 IP fixo

Sem isso, o endereço muda a cada reinício da instância — e o certificado HTTPS quebra junto.

```bash
export ID=$(aws ec2 describe-instances --region $REGIAO \
  --filters "Name=tag:Name,Values=$NOME" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

export ALOC=$(aws ec2 allocate-address --region $REGIAO --domain vpc \
  --query 'AllocationId' --output text)

aws ec2 associate-address --region $REGIAO \
  --instance-id $ID --allocation-id $ALOC

aws ec2 describe-addresses --region $REGIAO --allocation-ids $ALOC \
  --query 'Addresses[0].PublicIp' --output text
```

O último comando imprime o IP. **Aponte seu domínio para ele agora** (no DuckDNS ou no painel do registrador).

> O IP elástico é gratuito **enquanto estiver associado a uma instância em execução**. Se você desligar a instância e deixar o IP reservado, a AWS cobra por ele.

### 3.5 Swap — importante no t3.micro

Com 1 GB de RAM, Postgres e Node juntos podem esbarrar no limite. Conecte e configure:

```bash
ssh -i ~/.ssh/$NOME-key.pem ubuntu@$DOMINIO
sudo cloud-init status --wait      # aguarda o provisionamento terminar

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Usar swap só quando realmente faltar RAM, não por antecipação
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl -p /etc/sysctl.d/99-swap.conf
```

> Este é o **único** uso de SSH no processo, e é administrativo — não é deploy. O deploy acontece pelo registry (seção 5).

---

## 4. Segredos e subida

Ainda conectado:

```bash
sudo cp /opt/ihome/.env.example /opt/ihome/.env
sudo nano /opt/ihome/.env
```

Preencha:

```bash
DOMINIO=ihome-eduardo.duckdns.org
GITHUB_REPO=dudufritz
POSTGRES_USER=ihome
POSTGRES_PASSWORD=<gere abaixo>
JWT_SECRET=<gere abaixo>
ENCRYPTION_KEY=<gere abaixo>
GEMINI_API_KEY=<sua chave>
GMAIL_USER=<seu e-mail>
GMAIL_APP_PASSWORD=<senha de app do Gmail>
```

Gere cada segredo com `openssl rand -hex 32`.

> ⚠️ **Guarde `JWT_SECRET` e `ENCRYPTION_KEY` fora do servidor.** Trocar a primeira desconecta todos os usuários; perder a segunda torna os segredos Tuya já cifrados **irrecuperáveis**.

```bash
sudo chmod 600 /opt/ihome/.env
sudo systemctl start ihome
sudo docker compose -f /opt/ihome/docker-compose.prod.yml ps
```

O Caddy pede o certificado ao Let's Encrypt na primeira subida. Leva de 10 a 60 segundos. Se falhar, é quase sempre porque o domínio ainda não aponta para o IP — a propagação do DNS pode levar alguns minutos.

---

## 5. Deploy: por que não há SSH

O Playbook marca **"Deploy via acesso ssh/ftp" como 🚫 Não Usar** — item de reprovação direta. O fluxo evita SSH por construção:

```
git push origin main
        │
        ▼
GitHub Actions ── testes ── portão de cobertura ── SonarCloud
        │
        ▼
constrói a imagem e publica no GHCR
        │
        ▼  (a instância observa o registry)
Watchtower detecta a tag :latest nova
        │
        ▼
baixa, troca o contêiner e remove a imagem antiga
```

O pipeline **nunca toca no servidor**. Ele publica num registry; a máquina converge sozinha, verificando a cada 2 minutos. Esse desenho é o motivo de a troca de nuvem ter custado tão pouco: o pipeline não sabe — nem precisa saber — onde a aplicação roda.

### Segredos do GitHub Actions

| Secret | Onde obter |
|---|---|
| `SONAR_TOKEN` | sonarcloud.io → My Account → Security |

Só isso. O `GITHUB_TOKEN` que publica no GHCR é fornecido automaticamente.

Em **Settings → Actions → General → Workflow permissions**, marque **Read and write permissions**, senão o envio da imagem é recusado.

Defina também a variável `PRODUCTION_URL` (Settings → Secrets and variables → Actions → **Variables**) como `https://ihome-eduardo.duckdns.org`, para o pipeline conferir a produção após publicar.

---

## 6. Verificação

```bash
curl https://ihome-eduardo.duckdns.org/api/health
# esperado: {"ok":true,"push":true}

curl -I https://ihome-eduardo.duckdns.org
# esperado: HTTP/2 200

echo | openssl s_client -connect ihome-eduardo.duckdns.org:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

Checklist no navegador:

- [ ] criar conta e receber o e-mail de confirmação
- [ ] fazer login e continuar logado após recarregar
- [ ] cadastrar credenciais Tuya e descobrir dispositivos
- [ ] ligar e desligar um dispositivo
- [ ] convidar outro e-mail e aceitar pelo link
- [ ] ver a ação do convidado na tela de Auditoria
- [ ] instalar o PWA pelo celular

---

## 7. Operação

```bash
# Estado
sudo docker compose -f /opt/ihome/docker-compose.prod.yml ps

# Logs
sudo docker compose -f /opt/ihome/docker-compose.prod.yml logs -f api

# Memória — o que mais importa no t3.micro
free -h
sudo docker stats --no-stream

# Backup manual (o automático roda às 4h)
sudo /opt/ihome/backup.sh
ls -lh /opt/ihome/backups/
```

### Restaurar

```bash
gunzip -c /opt/ihome/backups/ihome-20261201-040000.sql.gz \
  | sudo docker compose -f /opt/ihome/docker-compose.prod.yml exec -T db \
    psql -U ihome -d ihome
```

> Teste a restauração **antes** de precisar dela.

### Controlar o gasto

```bash
aws ec2 stop-instances  --region $REGIAO --instance-ids $ID
aws ec2 start-instances --region $REGIAO --instance-ids $ID
```

Instância parada não gera custo de computação; o disco continua sendo cobrado (~US$ 2,40/mês). A stack volta sozinha no boot, pelo serviço systemd.

**Configure um alerta de orçamento** — a AWS não avisa sozinha quando o crédito acaba, e a cobrança passa a valer:

```bash
aws budgets create-budget --account-id $(aws sts get-caller-identity --query Account --output text) \
  --budget '{"BudgetName":"ihome","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}'
```

> Não deixe a instância parada perto da entrega. O requisito é *"pública e estável até a divulgação final das notas"*.

---

## 8. Se algo der errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Certificado não emite | DNS ainda não propagou, ou porta 80 fechada | `dig +short SEU-DOMINIO` deve devolver o IP elástico |
| Certificado recusado | Domínio `amazonaws.com` | Let's Encrypt não emite para ele — use DuckDNS ou domínio próprio (3.1) |
| `502 Bad Gateway` | A API não subiu | `docker compose logs api` — quase sempre `.env` incompleto |
| API reinicia em laço | Falta de memória | `free -h`; confira se o swap da 3.5 foi criado |
| Login falha com 500 | `JWT_SECRET` ausente | Conferir `.env` e `systemctl restart ihome` |
| Deploy não chega | Watchtower parado, ou pacote GHCR privado | `docker logs <watchtower>`; o pacote precisa ser público |
| Cobrança inesperada | IP elástico reservado sem instância ativa | Libere o IP ou mantenha a instância ligada |
