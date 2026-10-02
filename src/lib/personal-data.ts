import type { Pool, PoolClient } from "pg";

/**
 * Права субъекта персональных данных: доступ к своим данным и удаление аккаунта.
 *
 * Основание — ст. 14, 20 и 21 152-ФЗ: субъект вправе получить свои данные и
 * потребовать их уничтожения, а оператор обязан уложиться в срок. В проекте до
 * этого не было ни выгрузки, ни удаления, хотя Политика и Условия их обещают.
 *
 * Почему удаление — это обезличивание, а не `delete from users`: на `users`
 * ссылаются 34 внешних ключа с запретом удаления (ревизии, решения редакции,
 * задачи согласования, журналы публикаций). Физическое удаление строки либо
 * упало бы, либо унесло бы чужие данные по каскаду. Поэтому персональные данные
 * стираются, а идентификатор остаётся технической ссылкой без сведений о человеке.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type DataExport = {
  generatedAt: string;
  account: {
    id: number;
    email: string | null;
    name: string | null;
    createdAt: string | null;
    onboardingCompletedAt: string | null;
    hasPassword: boolean;
  };
  consents: Array<{
    kind: string;
    granted: boolean;
    at: string;
    source: string | null;
    policyVersion: string | null;
    consentTextVersion: string | null;
  }>;
  projects: Array<{ id: number; name: string; role: string | null; personal: boolean; joinedAt: string | null }>;
  channels: Array<{ id: number; title: string | null; network: string | null; createdAt: string | null }>;
  posts: Array<{ id: number; channelId: number | null; status: string | null; createdAt: string | null }>;
  drafts: Array<{ id: number; projectId: number | null; excerpt: string | null; createdAt: string | null }>;
  sessions: { active: number };
};

/**
 * Собирает выгрузку по одному пользователю.
 *
 * Что НЕ попадает в выгрузку: хеши паролей, токены подключений, служебные
 * идентификаторы площадок, journals безопасности. Выгрузка — это данные субъекта,
 * а не внутренние секреты оператора; для читателя отчёта перечень исключений
 * возвращается отдельно, чтобы границу было видно.
 */
export const DATA_EXPORT_EXCLUDED = [
  "хеш пароля",
  "токены подключённых площадок",
  "внутренние идентификаторы мессенджеров",
  "журналы безопасности и служебные записи",
] as const;

export async function collectUserData(client: Queryable, userId: number): Promise<DataExport> {
  const account = await client.query<{
    id: number;
    email: string | null;
    name: string | null;
    created_at: Date | string | null;
    onboarding_completed_at: Date | string | null;
    has_password: boolean;
  }>(
    `select id, email, name, created_at, onboarding_completed_at,
            (password_hash is not null) as has_password
       from users where id = $1`,
    [userId],
  );
  const row = account.rows[0];
  if (!row) throw new Error("user_not_found");

  const iso = (value: Date | string | null | undefined) =>
    value == null ? null : value instanceof Date ? value.toISOString() : String(value);

  const consents = await client.query<{
    kind: string; granted: boolean; granted_at: Date | string; source: string | null;
    policy_version: string | null; consent_text_version: string | null;
  }>(
    `select kind, granted, granted_at, source, policy_version, consent_text_version
       from consents where user_id = $1 order by granted_at desc, id desc`,
    [userId],
  );

  const projects = await client.query<{
    id: number; name: string; role: string | null; personal: boolean; joined_at: Date | string | null;
  }>(
    `select p.id, p.name, m.role, (p.personal_owner_user_id = $1) as personal, m.joined_at
       from projects p
       left join project_members m on m.project_id = p.id and m.user_id = $1
      where p.personal_owner_user_id = $1 or m.user_id = $1
      order by p.id`,
    [userId],
  );

  // Колонки connected_at у каналов нет: момент подключения виден по created_at.
  const channels = await client.query<{
    id: number; title: string | null; network: string | null; created_at: Date | string | null;
  }>(
    `select id, title, network, created_at from channels where user_id = $1 order by id`,
    [userId],
  );

  const posts = await client.query<{
    id: number; channel_id: number | null; status: string | null; created_at: Date | string | null;
  }>(
    `select id, channel_id, status, created_at from posts where user_id = $1 order by id limit 500`,
    [userId],
  );

  // У черновика нет заголовка: отдаём начало текста, чтобы человек узнал материал,
  // и не отдаём текст целиком — это уже контент, а не персональные данные.
  const drafts = await client.query<{
    id: number; project_id: number | null; excerpt: string | null; created_at: Date | string | null;
  }>(
    `select id, project_id, left(text, 80) as excerpt, created_at
       from drafts where user_id = $1 order by id limit 500`,
    [userId],
  );

  const sessions = await client.query<{ active: string | number }>(
    `select count(*)::int as active from sessions where user_id = $1`,
    [userId],
  );

  return {
    generatedAt: new Date().toISOString(),
    account: {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: iso(row.created_at),
      onboardingCompletedAt: iso(row.onboarding_completed_at),
      hasPassword: row.has_password === true,
    },
    consents: consents.rows.map((item) => ({
      kind: item.kind,
      granted: item.granted === true,
      at: iso(item.granted_at) ?? "",
      source: item.source,
      policyVersion: item.policy_version,
      consentTextVersion: item.consent_text_version,
    })),
    projects: projects.rows.map((item) => ({
      id: item.id,
      name: item.name,
      role: item.role,
      personal: item.personal === true,
      joinedAt: iso(item.joined_at),
    })),
    channels: channels.rows.map((item) => ({
      id: item.id,
      title: item.title,
      network: item.network,
      createdAt: iso(item.created_at),
    })),
    posts: posts.rows.map((item) => ({
      id: item.id,
      channelId: item.channel_id,
      status: item.status,
      createdAt: iso(item.created_at),
    })),
    drafts: drafts.rows.map((item) => ({
      id: item.id,
      projectId: item.project_id,
      excerpt: item.excerpt?.trim() || null,
      createdAt: iso(item.created_at),
    })),
    sessions: { active: Number(sessions.rows[0]?.active ?? 0) },
  };
}

/**
 * Участники, которым можно передать проект.
 *
 * Передать проект можно только действующему участнику: `project_members` с
 * ролью и статусом active. Это же ограничение проверяет серверная сторона —
 * иначе через тело запроса можно было бы назначить владельцем произвольный
 * идентификатор пользователя.
 */
export async function findTransferCandidates(
  client: Queryable,
  projectId: number,
  exceptUserId: number,
): Promise<Array<{ userId: number; name: string | null; role: string }>> {
  const result = await client.query<{ user_id: number; name: string | null; role: string }>(
    `select member.user_id, app_user.name, member.role
       from project_members member
       join users app_user on app_user.id = member.user_id
      where member.project_id = $1
        and member.user_id <> $2
        and member.status = 'active'
      order by case member.role when 'owner' then 0 when 'publisher' then 1 when 'author' then 2 else 3 end,
               member.joined_at asc`,
    [projectId, exceptUserId],
  );
  return result.rows.map((row) => ({ userId: Number(row.user_id), name: row.name, role: row.role }));
}

export type PurgeBlockReason = "shared_project_owner" | "invalid_transfer_target";

export type PurgeResult =
  | {
      ok: true;
      deletedPersonalProjects: number;
      /** Командные проекты, оставшиеся без участников: удалены вместе с аккаунтом. */
      deletedSharedProjects: number[];
      transferredSharedProjects: number[];
      anonymizedEmail: string;
    }
  | { ok: false; error: PurgeBlockReason; projects: Array<{ id: number; name: string }> };

export type PurgeBlocker = {
  id: number;
  name: string;
  /** Есть ли кому передать владение: другие действующие участники проекта. */
  hasOtherMembers: boolean;
};

/**
 * Проекты, которые мешают удалить аккаунт.
 *
 * Блокер — командный проект, где уходящий единственный действующий владелец:
 * платформа держит инвариант «в проекте всегда есть активный владелец»
 * (changeProjectMembership бросает last_owner), поэтому такой проект нельзя
 * оставить без присмотра. Личные проекты не блокируют: они уходят вместе с
 * аккаунтом.
 *
 * Первая версия этой проверки требовала «нет других участников вообще» — и это
 * было ошибкой: множество блокеров не пересекалось с множеством кандидатов на
 * передачу, поэтому передача не могла сработать ни разу, а удаление аккаунта
 * единственного владельца превращалось в тупик.
 */
export async function findPurgeBlockers(client: Queryable, userId: number): Promise<PurgeBlocker[]> {
  const result = await client.query<{ id: number; name: string; has_other_members: boolean }>(
    `select p.id,
            p.name,
            exists (
              select 1 from project_members other
               where other.project_id = p.id
                 and other.user_id <> $1
                 and other.status = 'active'
            ) as has_other_members
       from projects p
       join project_members m on m.project_id = p.id and m.user_id = $1
      where p.personal_owner_user_id is null
        and m.role = 'owner'
        and m.status = 'active'
        and not exists (
          select 1 from project_members co_owner
           where co_owner.project_id = p.id
             and co_owner.user_id <> $1
             and co_owner.role = 'owner'
             and co_owner.status = 'active'
        )
      order by p.id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    hasOtherMembers: row.has_other_members === true,
  }));
}

/**
 * Удаляет личный проект вместе со всем, что на него ссылается.
 *
 * Почему не списком таблиц: на `projects` ссылаются десятки таблиц с запретом
 * удаления, и список пришлось бы догонять после каждой новой миграции — ровно
 * так и появились первые ошибки 23503 (сначала user_project_preferences, потом
 * audit_events). Поэтому блокирующие ссылки разрешаются итеративно по данным
 * системного каталога: строки, которые ссылаются на удаляемый проект,
 * удаляются, а nullable-ссылки обнуляются. Всё внутри транзакции вызывающего.
 */
async function resolveProjectBlockers(client: Queryable, projectId: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // Savepoint обязателен: после ошибки PostgreSQL переводит транзакцию в
    // состояние «aborted», и любой следующий запрос отклоняется (25P02), даже
    // если ошибку поймали в JavaScript. Откат к savepoint возвращает
    // транзакцию в рабочее состояние.
    await client.query("savepoint project_delete");
    const failure = await client
      .query(`delete from projects where id = $1`, [projectId])
      .then(() => null)
      .catch((error: unknown) => error);
    if (!failure) {
      await client.query("release savepoint project_delete");
      return;
    }
    await client.query("rollback to savepoint project_delete");

    const code = failure && typeof failure === "object" && "code" in failure ? String(failure.code) : "";
    if (code !== "23503") throw failure;
    const constraint = failure && typeof failure === "object" && "constraint" in failure
      ? String((failure as { constraint?: string }).constraint ?? "")
      : "";
    if (!constraint) throw failure;

    const resolved = await resolveBlockingConstraint(client, constraint, projectId);
    if (!resolved) throw failure;
  }
  throw new Error("project_delete_blockers_unresolved");
}

/**
 * Разрешает одну блокирующую ссылку: удаляет ссылающиеся строки либо
 * обнуляет nullable-колонку. Возвращает false, если ссылку разрешить нельзя.
 */
async function resolveBlockingConstraint(
  client: Queryable,
  constraint: string,
  projectId: number,
): Promise<boolean> {
  const meta = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    is_nullable: string;
  }>(
    `select ns.nspname as table_schema,
            tbl.relname as table_name,
            att.attname as column_name,
            case when att.attnotnull then 'NO' else 'YES' end as is_nullable
       from pg_constraint con
       join pg_class tbl on tbl.oid = con.conrelid
       join pg_namespace ns on ns.oid = tbl.relnamespace
       join pg_attribute att on att.attrelid = tbl.oid and att.attnum = con.conkey[1]
      where con.conname = $1 and array_length(con.conkey, 1) = 1`,
    [constraint],
  );
  const target = meta.rows[0];
  if (!target) return false;
  // Системные таблицы не трогаем: это не данные проекта.
  if (target.table_schema !== "public") return false;

  const table = `"${target.table_name}"`;
  const column = `"${target.column_name}"`;
  if (target.is_nullable === "YES") {
    await client.query(`update ${table} set ${column} = null where ${column} = $1`, [projectId]);
    return true;
  }

  // Особый случай: «выбранный проект» в настройках пользователя. Ссылка
  // обязательная, но удалять всю строку нельзя — она хранит ещё и предпочтения
  // человека, который к удаляемому проекту отношения не имеет. Поэтому
  // переводим выбор на любой другой доступный ему проект.
  if (target.table_name === "user_project_preferences") {
    await client.query(
      `update user_project_preferences prefs
          set selected_project_id = (
                select candidate.id
                  from projects candidate
                 where candidate.id <> $1
                   and (candidate.personal_owner_user_id = prefs.user_id
                        or exists (select 1 from project_members member
                                    where member.project_id = candidate.id
                                      and member.user_id = prefs.user_id
                                      and member.status = 'active'))
                 order by candidate.id
                 limit 1
              ),
              updated_at = now()
        where prefs.selected_project_id = $1
          and exists (
                select 1 from projects candidate
                 where candidate.id <> $1
                   and (candidate.personal_owner_user_id = prefs.user_id
                        or exists (select 1 from project_members member
                                    where member.project_id = candidate.id
                                      and member.user_id = prefs.user_id
                                      and member.status = 'active'))
              )`,
      [projectId],
    );
    // Если другого проекта нет, выбора не остаётся — тогда строку убираем.
    await client.query(`delete from ${table} where ${column} = $1`, [projectId]);
    return true;
  }

  // Журналы проекта (например, audit_events) удаляются целиком, включая
  // действия других людей: проект личный, и его следы уходят по запросу
  // субъекта. Сам факт удаления и его время остаются в data_requests.
  await client.query(`delete from ${table} where ${column} = $1`, [projectId]);
  return true;
}

/**
 * Удаляет аккаунт: личные проекты целиком, командные — передать или отказать,
 * персональные данные обезличить, сессии и согласия закрыть.
 *
 * Всё в одной транзакции: частично удалённый аккаунт хуже, чем отказ с понятной
 * причиной, потому что восстановить его нельзя.
 */
export async function purgeAccount(
  client: PoolClient,
  userId: number,
  options: { transferSharedTo?: number | null } = {},
): Promise<PurgeResult> {
  const blockers = await findPurgeBlockers(client, userId);
  // Проекты, где есть кому передать владение: без выбора преемника удаление
  // оставило бы их без владельца, а это ломает инвариант платформы.
  const transferable = blockers.filter((project) => project.hasOtherMembers);
  // Проекты, где участников больше нет: они существуют только ради уходящего,
  // поэтому уходят вместе с аккаунтом — как личные. Иначе человек оказывался бы
  // в тупике: передать некому, а удалить аккаунт нельзя.
  const orphaned = blockers.filter((project) => !project.hasOtherMembers);

  if (transferable.length > 0 && !options.transferSharedTo) {
    return { ok: false, error: "shared_project_owner", projects: transferable };
  }

  // Проверяем цель передачи ДО удаления личных проектов: получить проект может
  // только действующий участник этого проекта. Иначе через тело запроса можно
  // было бы назначить владельцем произвольный идентификатор, а транзакция
  // успела бы удалить данные пользователя. Один преемник должен подходить
  // каждому проекту, иначе выбор неоднозначен и запрос отклоняется.
  if (transferable.length > 0 && options.transferSharedTo) {
    for (const project of transferable) {
      const candidates = await findTransferCandidates(client, project.id, userId);
      if (!candidates.some((candidate) => candidate.userId === options.transferSharedTo)) {
        return { ok: false, error: "invalid_transfer_target", projects: [project] };
      }
    }
  }

  // Личные проекты уходят целиком вместе с каналами, черновиками и публикациями:
  // они существуют только ради этого аккаунта.
  const personalProjects = await client.query<{ id: number }>(
    `select id from projects where personal_owner_user_id = $1 order by id`,
    [userId],
  );
  for (const project of personalProjects.rows) {
    await resolveProjectBlockers(client, project.id);
  }

  const transferred: number[] = [];
  if (options.transferSharedTo) {
    for (const project of transferable) {
      // rowCount проверяем: между выбором кандидатов и этим UPDATE участника
      // могли отозвать (revokeProjectMember ставит status='revoked'). Тогда
      // проект остался бы без обещанного владельца, а аккаунт уже обезличен.
      const updated = await client.query(
        `update project_members set role = 'owner', version = version + 1, updated_at = now()
          where project_id = $1 and user_id = $2 and status = 'active'`,
        [project.id, options.transferSharedTo],
      );
      if ((updated.rowCount ?? 0) === 0) {
        return { ok: false, error: "invalid_transfer_target", projects: [project] };
      }
      transferred.push(project.id);
    }
  }

  // Осиротевшие командные проекты уходят вместе с аккаунтом: участников в них
  // не осталось, и держать их не для кого.
  for (const project of orphaned) {
    await resolveProjectBlockers(client, project.id);
  }

  // Членство уходящего отзываем во всех проектах, включая те, где владение
  // передано. Иначе остаётся «призрачный» active-owner: аккаунт обезличен,
  // войти нельзя, а платформа считает, что владелец на месте, — и проект
  // нельзя ни переименовать, ни передать, потому что members.manage есть
  // только у владельца. Штатный выход из проекта делает то же самое
  // (revokeProjectMember: status='revoked', revoked_at).
  await client.query(
    `update project_members
        set status = 'revoked', revoked_at = now(), version = version + 1, updated_at = now()
      where user_id = $1 and status = 'active'`,
    [userId],
  );

  // Обезличивание: сведения о человеке стираются, идентификатор остаётся
  // технической ссылкой для журналов, которые закон требует хранить.
  const anonymizedEmail = `deleted-user-${userId}@deleted.invalid`;
  await client.query(
    `update users
        set email = $2,
            name = null,
            avatar = null,
            password_hash = null,
            tg_id = null,
            vk_id = null,
            ai_mood = null,
            ai_post_settings = '{}'::jsonb
      where id = $1`,
    [userId, anonymizedEmail],
  );

  // Сессии и согласия: вход прекращается сразу, согласие перестаёт действовать.
  // Записи согласий помечаем отозванными, а не оставляем действующими: строка
  // журнала живёт до физического удаления пользователя (связь объявлена как
  // on delete cascade), и в этот промежуток она не должна выглядеть как
  // действующее согласие. Сам факт удаления и его время фиксирует data_requests.
  await client.query(`delete from sessions where user_id = $1`, [userId]);
  await client.query(
    `update consents set granted = false where user_id = $1 and granted = true`,
    [userId],
  );

  return {
    ok: true,
    deletedPersonalProjects: personalProjects.rows.length,
    deletedSharedProjects: orphaned.map((project) => project.id),
    transferredSharedProjects: transferred,
    anonymizedEmail,
  };
}

/** Записывает факт запроса субъекта: срок и результат должны быть проверяемы. */
export async function recordDataRequest(
  client: Queryable,
  input: { userId: number; kind: "export" | "deletion"; state: "completed" | "pending"; result?: unknown },
): Promise<void> {
  await client.query(
    `insert into data_requests (user_id, kind, state, result, completed_at)
     values ($1, $2, $3, $4::jsonb, case when $3 = 'completed' then now() else null end)`,
    [input.userId, input.kind, input.state, JSON.stringify(input.result ?? {})],
  );
}
