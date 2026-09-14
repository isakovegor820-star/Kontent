"""Regenerate the reviewable HTTP inventory from explicit route policies and source links."""
from pathlib import Path
import json, re

src = Path('src')
policies = json.loads((src / 'lib/project-route-policies.json').read_text())
permissions = {'project.read', 'project.manage', 'members.manage', 'content.create', 'content.edit', 'content.submit', 'content.review', 'content.approve', 'content.publish', 'audience.reply.send', 'audit.read'}

def referenced_permissions(path, seen):
    if path in seen or path.name in {'project-permissions.ts', 'project-route.ts', 'session.ts'}:
        return set()
    seen.add(path)
    source = path.read_text()
    found = set(re.findall(r'["\x27]([a-z]+(?:\.[a-z]+)+)["\x27]', source)) & permissions
    for imported in re.findall(r'from\s+["\x27]([^"\x27]+)', source):
        base = src / imported[2:] if imported.startswith('@/') else path.parent / imported if imported.startswith('.') else None
        if base is None:
            continue
        for target in [base, Path(str(base) + '.ts'), Path(str(base) + '.tsx'), Path(str(base) + '.mjs'), base / 'index.ts']:
            if target.is_file():
                found |= referenced_permissions(target, seen)
                break
    return found

clients = {p: p.read_text() for base in ['src/app/app', 'src/components/app', 'src/components/studio', 'src/lib'] for p in Path(base).rglob('*.ts*') if '.test.' not in p.name}
lines = ['# HTTP-контракт проектов', '',
    'Реестр охватывает каждый явно экспортированный HTTP-метод. Неявный HEAD наследует GET; автоматический OPTIONS Next.js не читает данные.', '',
    'Для project-маршрутов селектор — `x-aurora-project-id` (либо `projectId` в URL для ссылок). Конфликт селекторов даёт 400, отсутствие — 428 после проверки сессии. Сервер проверяет действующее членство; объект другого проекта даёт 409/404. Ответ помечается тем же project ID и `private, no-store`.', '',
    'Исключения: immutable media URL выводит проект из asset ID и проверяет членство; `/projects/:id` может брать ID из пути. OAuth callback использует проект из одноразового состояния. Контекстные GET возвращают собственную идентичность; PUT переключения имеет явный целевой projectId. Account/public API не принимают глобальный выбор как полномочие.', '',
    'Колонка прав перечисляет права, упоминаемые обработчиком и его сервисами; конкретное условие для метода и роли находится в указанном исходнике. Колонка клиента перечисляет прямые HTTP-вызовы семейства; shared client вызывается компонентом через `useProjectCall`, а fetch — через `useProjectFetch`. Это инвентаризация для ревью, а не замена проверкам разрешений.', '',
    '| Метод и маршрут | Селектор / идентичность | Права обработчика и сервисов | Клиент HTTP | Операция |',
    '|---|---|---|---|---|']
for row in policies:
    path, method, policy = row['path'], row['method'], row['policy']
    file = src / 'app' / path.removeprefix('/') / 'route.ts'
    rights = referenced_permissions(file, set()) if policy == 'project' else set()
    prefix = path.split('[')[0]
    callers = [f'`{p.name}`' for p, text in clients.items() if prefix in text]
    selector = {'project': 'header / URL → membership', 'account': 'сессия аккаунта / admin guard', 'public': 'публичный ресурс / проверяемый public key', 'context': 'контекст + возвращаемый ID', 'callback': 'OAuth state.projectId → membership', 'retired': '410; запись закрыта'}[policy]
    if path == '/api/media/assets/[id]': selector = 'asset ID → project → membership'
    if path.startswith('/api/projects/[projectId]'): selector = 'path ID + header → membership'
    operation = 'чтение' if method in {'GET', 'HEAD'} else 'CORS' if method == 'OPTIONS' else 'создание / действие' if method == 'POST' else 'удаление / отмена' if method == 'DELETE' else 'изменение'
    lines.append(f'| [{method} {path}](../{file}) | {selector} | {", ".join(f"`{p}`" for p in sorted(rights)) or "см. guard в обработчике"} | {", ".join(sorted(set(callers))) or "прямой HTTP / service client"} | {operation} |')
Path('docs/project-route-inventory.md').write_text('\n'.join(lines) + '\n')
print(f'Documented {len(policies)} methods')
