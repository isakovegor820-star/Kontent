# Production-деплой админ-панели Aurora

Выполнен 5 сентября 2026 года. На production подтверждён коммит `da8cdf74fed7a0c4f2b63785804ed7864d86151b`.

- [PR №22](https://github.com/isakovegor820-star/Kontent/pull/22): слит после успешного CI.
- [CI main](https://github.com/isakovegor820-star/Kontent/actions/runs/33967363095): успешно, включая две сборки и сквозные сценарии в Chromium, Firefox и WebKit.
- [Deploy production](https://github.com/isakovegor820-star/Kontent/actions/runs/33968607552): успешно; проверки CI, readiness, границы отката и состояния после переключения прошли.
- [Production release audit](https://github.com/isakovegor820-star/Kontent/actions/runs/33968859470): точный SHA подтверждён, web/worker активны, health успешен.
- HTTPS-проверки: новая admin-разметка и вход возвращают 200; новые API подключений и расходов без сессии возвращают 401.
- Браузер: экран завершённой сессии и переход к форме входа работают, ошибок JavaScript не зарегистрировано. Административные изменения реальных данных при проверке не выполнялись.
- Временная пауза автодеплоя снята: `AUTO_DEPLOY_ENABLED=true` восстановлен и проверен.

## Сохранённые ограничения

Денежный журнал AI пока отсутствует в production-схеме; экран прямо сообщает, что стоимость и резервы неизвестны. Расходы не подменяются нулями.

Текущая почтовая доставка и восстановление пароля не подтверждены полной readiness-проверкой. Существующая настройка `ALLOW_DEGRADED_MAIL=true` допускает этот режим для релиза. Перед выкладкой AI readiness восстановлена штатным workflow; после выкладки release readiness прошла.

Локальные тестовые скриншоты и полный interface review доступны в [review.md](review.md). Проверки production сохранены в [production-http-verification.json](production-http-verification.json) и [production-release-audit.txt](production-release-audit.txt).
