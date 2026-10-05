#!/bin/bash
# Локальный сторож «прода» на :3000 (launchd-агент ru.aurora.web).
#
# Зачем: launchd умеет следить только за живостью процесса, а не за тем, отвечает ли
# он по HTTP. Инцидент 2026-10-05 показал цену этого: процесс сутки висел живым и
# отдавал 500 на каждый запрос, а KeepAlive считал сервис здоровым.
#
# Правила логирования: пишем переходы (ok -> сбой и сбой -> ok) и повторяем строку
# о продолжающемся сбое не чаще раза в час, чтобы файл не рос как 10-мегабайтный
# Aurora-web.error.log. Код возврата: 0 — здоров, 1 — нет.
#
# Переменные окружения (все необязательные):
#   AURORA_LOCAL_HEALTH_URL    база сервиса, по умолчанию http://127.0.0.1:3000
#   AURORA_LOCAL_HEALTH_LOG    файл журнала, ~/Library/Logs/Aurora-health.log
#   AURORA_LOCAL_HEALTH_STATE  файл состояния, ~/Library/Logs/Aurora-health.state
set -uo pipefail

BASE="${AURORA_LOCAL_HEALTH_URL:-http://127.0.0.1:3000}"
LOG="${AURORA_LOCAL_HEALTH_LOG:-$HOME/Library/Logs/Aurora-health.log}"
STATE="${AURORA_LOCAL_HEALTH_STATE:-$HOME/Library/Logs/Aurora-health.state}"
REPEAT_SECONDS="${AURORA_LOCAL_HEALTH_REPEAT_SECONDS:-3600}"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/health" 2>/dev/null || true)"
[ -n "$code" ] || code="000"

previous="$(cut -d'|' -f1 "$STATE" 2>/dev/null || true)"
logged_at="$(cut -d'|' -f2 "$STATE" 2>/dev/null || true)"
now="$(date +%s)"
[ -n "$logged_at" ] || logged_at=0

stamp="$(date '+%Y-%m-%d %H:%M:%S')"

if [ "$code" = "200" ]; then
  if [ "$previous" != "200" ]; then
    printf '%s ok    %s/api/health -> 200 (сервис отвечает)\n' "$stamp" "$BASE" >> "$LOG"
  fi
  printf '200|%s' "$now" > "$STATE"
  exit 0
fi

if [ "$previous" != "$code" ] || [ $(( now - logged_at )) -ge "$REPEAT_SECONDS" ]; then
  printf '%s FAIL  %s/api/health -> %s (сервис ru.aurora.web не отвечает; логи процесса: ~/Library/Logs/Aurora-web.error.log)\n' \
    "$stamp" "$BASE" "$code" >> "$LOG"
  printf '%s|%s' "$code" "$now" > "$STATE"
fi

exit 1
