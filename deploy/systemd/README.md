# systemd-юниты продакшена

Этот каталог — источник истины для двух долгоживущих процессов Авроры. До ревью
2026-09 юниты существовали только на сервере: политика рестарта («кто поднимет
воркер после падения») не была закреплена в коде, и каскадная смерть всех
подсистем не имела страховки. Теперь:

- `aurora-worker.service` / `aurora-web.service` — `Restart=always` с ограничением
  частоты рестартов (`StartLimit*`);
- сам воркер при фатальной ошибке отчитывается в Sentry и выходит с кодом 1
  (`worker/crash-guards.mjs`), то есть падает громко и предсказуемо;
- `scripts/deploy-production.sh` перезапускает ровно эти имена сервисов.

## Установка (первый раз или после изменения файлов)

```bash
sudo cp deploy/systemd/aurora-web.service /etc/systemd/system/
sudo cp deploy/systemd/aurora-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aurora-web.service aurora-worker.service
```

## Проверка

```bash
systemctl status aurora-web.service aurora-worker.service   # active (running)
journalctl -u aurora-worker.service -n 50                    # видно «фатальная ошибка процесса»
sudo systemd-analyze security aurora-worker.service          # уровень hardening
```

## Отличия от серверной конфигурации

Файлы описывают ожидаемый layout (`/opt/aurora-current`, `.env.production`,
пользователь `aurora`, порт web из `AURORA_HEALTH_URL`). Если на хосте уже есть
дрейфующая версия юнита — приведите её к этим файлам; при следующем деплое
расхождений быть не должно.

## Разделение воркера под нагрузкой

По умолчанию один процесс слушает всё. Готовые режимы для выноса тяжёлых
подсистем в отдельные экземпляры (копируйте юнит, добавьте
`Environment=AURORA_WORKER_MODE=publication` и другое `ExecStart` из
`package.json` — `worker:publication`, `worker:media`):

- `publication` — только очереди публикаций (главный путь пользователя);
- `media` — генерация медиа;
- остальные — «всё, кроме» вынесенного (полный режим с отключёнными частями
  задаётся расписанием крона и флагами окружения).
