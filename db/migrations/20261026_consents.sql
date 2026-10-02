-- Согласия на обработку персональных данных: журнал доказательств.
--
-- Зачем отдельная таблица, а не колонка «согласен» в users: согласие нужно
-- доказывать (ч. 1, ч. 3 ст. 9 152-ФЗ), а доказательство — это не флаг, а запись
-- с временем, версией текста, версией политики и источником. Согласий у одного
-- человека несколько (обработка ПДн, рассылки, распространение), и у каждого
-- свой срок жизни, поэтому строк в журнале больше одной.
--
-- Отзыв согласия — новая строка с granted = false, а не удаление: политика
-- миграций запрещает DELETE, и это правильно — история согласий и есть
-- доказательство. Актуальное состояние читается последней записью по виду.
--
-- Версии текста и политики — text без CHECK и перечислений: утверждённая
-- редакция меняет константу в коде, а не схему. Обратный пример уже был в
-- проекте: media_prompt_policy_version пришлось расширять через drop constraint.
begin;

create table if not exists consents (
  id                    bigint generated always as identity primary key,

  -- Кто дал согласие: аккаунт или контакт из формы. Заполняется хотя бы одно
  -- поле; проверку держит код, потому что CHECK-констрейнт потребовал бы
  -- отдельного согласования в allowlist политики миграций.
  user_id               bigint references users (id) on delete set null,
  contact               text,

  -- Вид согласия: обработка ПДн, рассылки, распространение, cookie.
  kind                  text not null,

  -- false — отзыв согласия. История не переписывается.
  granted               boolean not null default true,

  -- Время согласия или отзыва: момент, который подтверждает оператор.
  granted_at            timestamptz not null default now(),

  -- Чем подтверждается: адрес запроса и клиент. Нужны как доказательство.
  ip                    text,
  user_agent            text,

  -- Версия текста согласия и версия политики на момент согласия.
  policy_version        text,
  consent_text_version  text,

  -- Где получено согласие: форма регистрации, лид-форма, кабинет.
  source                text,

  created_at            timestamptz not null default now()
);

-- Основной запрос: «последнее согласие этого пользователя по виду».
create index if not exists consents_user_kind_idx on consents (user_id, kind, granted_at desc);

-- Тот же вопрос для заявок без аккаунта: согласие привязано к контакту.
create index if not exists consents_contact_kind_idx on consents (contact, kind, granted_at desc);

-- Заявка помнит, что согласие было дано именно при её отправке: без этого
-- нельзя показать, на каком тексте человек согласился, если форма изменилась.
-- Guard: таблицы leads может не быть в базе, пришедшей с очень старой миграции
-- (интеграционный прогон стартует с legacy-фикстурой), а падать из-за этого
-- миграция не должна — журнал согласий от leads не зависит.
do $$
begin
  if to_regclass('public.leads') is not null then
    execute 'alter table leads add column if not exists consent_granted boolean';
    execute 'alter table leads add column if not exists consent_text_version text';
    execute 'alter table leads add column if not exists consent_at timestamptz';
  end if;
end $$;

commit;
