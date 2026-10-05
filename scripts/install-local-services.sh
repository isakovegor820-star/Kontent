#!/bin/bash
# Устанавливает локальные launchd-сервисы Авроры из репозитория.
#
# Зачем: до 05.10.2026 определения сервисов жили только в ~/Library/LaunchAgents —
# вне репозитория. Ни один тест не мог заметить, что сервис разошёлся с контрактом
# запуска приложения, и инцидент 2026-10-05 стоил суток простоя: web-процесс отвечал
# 500 на каждый запрос, оставаясь «живым» для KeepAlive.
#
# Использование:
#   scripts/install-local-services.sh                 # web + сторож
#   scripts/install-local-services.sh --with-worker    # ещё и BullMQ-воркер
#   scripts/install-local-services.sh --dry-run        # только показать план
#
# Воркер по умолчанию НЕ ставится: он запускает публикации, и включать его нужно
# осознанно (см. deploy/launchd/README.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/deploy/launchd"
TARGET_DIR="${HOME}/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

services=(web health)
dry_run=0

for argument in "$@"; do
  case "$argument" in
    --with-worker) services=(web publication-worker health) ;;
    --dry-run) dry_run=1 ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Неизвестный аргумент: $argument" >&2
      exit 2
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Локальные сервисы ставятся только на macOS (launchd)." >&2
  exit 1
fi

echo "Репозиторий: ${REPO_ROOT}"
echo "Сервисы:     ${services[*]}"

install_service() {
  service="$1"
  source_plist="${SOURCE_DIR}/ru.aurora.${service}.plist"
  target_plist="${TARGET_DIR}/ru.aurora.${service}.plist"
  label="ru.aurora.${service}"

  if [ ! -f "$source_plist" ]; then
    echo "Нет определения сервиса: $source_plist" >&2
    exit 1
  fi
  plutil -lint "$source_plist" >/dev/null

  # Пути внутри плистов абсолютные. Если репозиторий переехал, сервис молча
  # запустил бы чужой код или не нашёл .next — поэтому проверяем явно.
  if ! grep -qF "$REPO_ROOT" "$source_plist"; then
    echo "Плист $source_plist не ссылается на ${REPO_ROOT}." >&2
    echo "Обнови пути в deploy/launchd/*.plist и повтори." >&2
    exit 1
  fi

  echo "→ ${label}"
  if [ "$dry_run" = "1" ]; then
    echo "   скопировал бы ${source_plist} → ${target_plist}"
    echo "   bootout ${DOMAIN}/${label} (если загружен), затем bootstrap"
    return 0
  fi

  cp "$source_plist" "$target_plist"
  launchctl bootout "${DOMAIN}/${label}" 2>/dev/null || true

  # bootout асинхронен: bootstrap сразу после него падает с «Input/output error»,
  # и сервис остаётся лежать. Поэтому дожидаемся фактической выгрузки.
  for _ in $(seq 1 40); do
    launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1 || break
    sleep 0.5
  done

  # Задание могло остаться в базе отключённых (`launchctl disable`): тогда bootstrap
  # падает с «Input/output error», хотя плист валиден. Именно так воркер числился
  # disabled с 06.09.2026 и не поднимался, пока его не включили явно.
  launchctl enable "${DOMAIN}/${label}" 2>/dev/null || true

  loaded=1
  for _ in $(seq 1 10); do
    if launchctl bootstrap "${DOMAIN}" "$target_plist" 2>/dev/null; then
      loaded=0
      break
    fi
    sleep 1
  done

  if [ "$loaded" != "0" ] || ! launchctl print "${DOMAIN}/${label}" >/dev/null 2>&1; then
    echo "Не удалось загрузить ${label}." >&2
    echo "Определение на месте: ${target_plist}" >&2
    echo "Повтори вручную: launchctl bootstrap ${DOMAIN} ${target_plist}" >&2
    exit 1
  fi
}

# Порядок важен. Сторож поднимается ПОСЛЕ того, как web подтвердил готовность:
# иначе его RunAtLoad срабатывает, пока Next ещё не слушает порт, и в журнале
# появляется ложный FAIL (поймано прогоном 05.10.2026).
for service in "${services[@]}"; do
  [ "$service" = "health" ] && continue
  install_service "$service"
done

if [ "$dry_run" = "1" ]; then
  echo "→ ru.aurora.health"
  echo "   загрузил бы сторожа после подтверждённой готовности web"
  echo "Это был --dry-run: ничего не изменено."
  exit 0
fi

echo
# Web обязан ответить: молчаливо «живой» сервис — это и был инцидент 05.10.
ready=1
for _ in $(seq 1 15); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if [ "$code" = "200" ]; then
    ready=0
    break
  fi
  sleep 2
done

if [ "$ready" != "0" ]; then
  echo "health :3000 не ответил 200 за 30 секунд (последний код: ${code:-000})." >&2
  echo "Смотри ~/Library/Logs/Aurora-web.error.log и deploy/launchd/README.md." >&2
  exit 1
fi
echo "health :3000 → 200"

for service in "${services[@]}"; do
  [ "$service" = "health" ] || continue
  install_service "$service"
done

echo
echo "Состояние:"
launchctl list | grep -E "ru\.aurora\." || echo "  (сервисы не найдены — смотри журнал через launchctl print)"
