-- Запросы субъекта персональных данных: выгрузка своих данных и удаление аккаунта.
--
-- Зачем отдельная таблица, а не письмо в поддержку: закон даёт субъекту право
-- на доступ к своим данным и на их удаление (ст. 14, 20, 21 152-ФЗ), и оператор
-- обязан уложиться в срок (7 рабочих дней на уточнение/блокирование, 30 дней на
-- уничтожение). Запрос с отметкой времени и состоянием — это то, по чему видно
-- срок и факт исполнения; письмо в почте этого не доказывает.
--
-- Журнал append-only: сама выгрузка не хранится (её отдаёт ответ), хранится
-- факт запроса и результат. Состояния ведём текстом без CHECK: набор состояний
-- уточняется по мере появления автоматической обработки, и расширять его
-- миграцией каждый раз не нужно.
begin;

create table if not exists data_requests (
  id            bigint generated always as identity primary key,

  -- Кто запросил. on delete cascade: после удаления аккаунта персональных
  -- данных быть не должно, включая ссылку в этом журнале.
  user_id       bigint not null references users (id) on delete cascade,

  -- Вид запроса: доступ к данным (выгрузка) или удаление аккаунта.
  kind          text not null,

  -- Состояние: обработан сразу или ждёт ручного разбора оператором.
  state         text not null default 'completed',

  -- Что вернули или что помешало. Без персональных данных: только коды и числа.
  result        jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- Основной запрос оператора: «что ждёт ручного разбора», и пользователя:
-- «что я запрашивал». Оба идут по времени вниз.
create index if not exists data_requests_user_kind_idx on data_requests (user_id, kind, created_at desc);
create index if not exists data_requests_state_idx on data_requests (state, created_at desc);

commit;
