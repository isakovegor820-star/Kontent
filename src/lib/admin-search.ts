import type { Pool } from "pg";

type Queryable = Pick<Pool, "query">;

export interface AdminSearchHit {
  kind: "user" | "project" | "post";
  id: number;
  title: string;
  subtitle: string;
  badge: string | null;
}

export interface AdminSearchResponse {
  query: string;
  users: AdminSearchHit[];
  projects: AdminSearchHit[];
  posts: AdminSearchHit[];
}

const LIMIT_PER_KIND = 6;

export function normalizeAdminSearchQuery(value: string | null): string {
  return String(value ?? "").trim().replace(/\s+/gu, " ").slice(0, 120);
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * One query per entity kind, all bounded: numeric input matches ids exactly, everything
 * else is a case-insensitive substring over names/emails/texts. Never returns content
 * beyond a 120-character post preview.
 */
export async function searchAdminEntities(db: Queryable, rawQuery: string): Promise<AdminSearchResponse> {
  const query = normalizeAdminSearchQuery(rawQuery);
  const numeric = /^\d{1,15}$/u.test(query) ? Number(query) : null;
  // Free text needs two characters; a bare id (even a one-digit one) is always searchable.
  if (query.length < 2 && numeric === null) return { query, users: [], projects: [], posts: [] };
  const like = `%${query.replace(/[%_\\]/gu, (char) => `\\${char}`)}%`;
  const [users, projects, posts] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select app_user.id,
              coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as title,
              app_user.email, app_user.blocked_at is not null as blocked,
              (select count(*) from project_members member where member.user_id = app_user.id and member.status = 'active') as projects
         from users app_user
        where ($1::bigint is not null and app_user.id = $1)
           or app_user.name ilike $2 or app_user.email ilike $2
        order by (app_user.id = $1) desc nulls last, app_user.created_at desc
        limit $3`,
      [numeric, like, LIMIT_PER_KIND],
    ),
    db.query<Record<string, unknown>>(
      `select project.id, project.name as title, project.is_archived,
              (select count(*) from project_members member where member.project_id = project.id and member.status = 'active') as members,
              (select count(*) from channels channel where channel.project_id = project.id and channel.is_active) as channels
         from projects project
        where ($1::bigint is not null and project.id = $1) or project.name ilike $2
        order by (project.id = $1) desc nulls last, project.created_at desc
        limit $3`,
      [numeric, like, LIMIT_PER_KIND],
    ),
    db.query<Record<string, unknown>>(
      `select post.id, post.status,
              left(regexp_replace(post.text, '\\s+', ' ', 'g'), 120) as title,
              project.name as project, channel.network
         from posts post
         join projects project on project.id = post.project_id
         join channels channel on channel.id = post.channel_id
        where ($1::bigint is not null and post.id = $1) or post.text ilike $2
        order by (post.id = $1) desc nulls last, coalesce(post.scheduled_at, post.created_at) desc
        limit $3`,
      [numeric, like, LIMIT_PER_KIND],
    ),
  ]);
  return {
    query,
    users: users.rows.map((row) => ({
      kind: "user" as const,
      id: positiveId(row.id),
      title: String(row.title),
      subtitle: `${row.email ? String(row.email) : `ID ${positiveId(row.id)}`} · ${Number(row.projects)} проектов`,
      badge: row.blocked === true ? "заблокирован" : null,
    })),
    projects: projects.rows.map((row) => ({
      kind: "project" as const,
      id: positiveId(row.id),
      title: String(row.title),
      subtitle: `${Number(row.members)} участников · ${Number(row.channels)} каналов`,
      badge: row.is_archived === true ? "архив" : null,
    })),
    posts: posts.rows.map((row) => ({
      kind: "post" as const,
      id: positiveId(row.id),
      title: String(row.title || "Публикация без текста"),
      subtitle: `${String(row.project)} · ${String(row.network)}`,
      badge: String(row.status),
    })),
  };
}
