#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  Backup diário do PostgreSQL.
#
#  Numa VM não existe backup gerenciado — ao contrário do PostgreSQL
#  Flexible Server, que faz isso sozinho. Esta é a contrapartida de ter
#  escolhido a VM, e precisa existir: perder o banco na véspera do Demo
#  Day significa perder as contas, os dispositivos e a auditoria.
#
#  Instalado como tarefa diária pelo cloud-init.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="$DIR/backups"
RETENCAO_DIAS=14
ARQUIVO="$DESTINO/ihome-$(date +%Y%m%d-%H%M%S).sql.gz"

mkdir -p "$DESTINO"

# --clean --if-exists deixa o dump restaurável sobre um banco existente.
docker compose -f "$DIR/docker-compose.prod.yml" exec -T db \
  pg_dump -U "${POSTGRES_USER:-ihome}" --clean --if-exists ihome \
  | gzip > "$ARQUIVO"

# Um dump vazio é pior que nenhum: dá falsa sensação de segurança.
TAMANHO=$(stat -c%s "$ARQUIVO")
if [ "$TAMANHO" -lt 1000 ]; then
  echo "❌ Backup suspeito: apenas ${TAMANHO} bytes. Mantido para inspeção."
  exit 1
fi

# Remove os antigos só DEPOIS de confirmar que o novo é válido.
find "$DESTINO" -name 'ihome-*.sql.gz' -mtime +$RETENCAO_DIAS -delete

echo "✅ Backup: $(basename "$ARQUIVO") ($(numfmt --to=iec "$TAMANHO"))"
