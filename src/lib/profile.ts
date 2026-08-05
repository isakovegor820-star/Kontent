import { normalizeBrief, type Brief } from "./brief";

export const PROFILE_NAME_MAX = 120;
export const PROFILE_AVATAR_MAX = 1_000;
export const PROFILE_REQUEST_KEY_MAX = 128;

export const PROFILE_FORMAT_OPTIONS = Object.freeze([
  "Текст",
  "Фото",
  "Карусель",
  "Видео",
  "Короткое видео",
  "Аудио",
  "Опрос",
]);

export type ProfileUpdate = {
  requestKey: string;
  channelId: number;
  name: string;
  avatar: string;
  brief: Pick<Brief, "niche" | "audience" | "goal" | "rubrics" | "formats" | "authorRole" | "cta" | "taboo">;
};

export type ProfileInputResult =
  | { ok: true; value: ProfileUpdate }
  | { ok: false; error: "bad_request_key" | "bad_channel" | "bad_name" | "bad_avatar" | "incomplete_brief" };

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

export function validProfileRequestKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= PROFILE_REQUEST_KEY_MAX
    && /^[a-zA-Z0-9._:-]+$/u.test(value);
}

export function normalizeAvatar(value: unknown): string | null {
  const avatar = clean(value, PROFILE_AVATAR_MAX);
  if (!avatar) return "";
  if (/^\/api\/media\/assets\/[1-9][0-9]*$/u.test(avatar)) return avatar;
  try {
    const parsed = new URL(avatar);
    return parsed.protocol === "https:" ? parsed.toString().slice(0, PROFILE_AVATAR_MAX) : null;
  } catch {
    return null;
  }
}

export function parseProfileUpdate(raw: unknown, headerRequestKey?: string | null): ProfileInputResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "bad_request_key" };
  }
  const input = raw as Record<string, unknown>;
  const bodyRequestKey = input.requestKey;
  if (headerRequestKey && bodyRequestKey && headerRequestKey !== bodyRequestKey) {
    return { ok: false, error: "bad_request_key" };
  }
  const requestKey = headerRequestKey || bodyRequestKey;
  if (!validProfileRequestKey(requestKey)) return { ok: false, error: "bad_request_key" };

  const channelId = Number(input.channelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return { ok: false, error: "bad_channel" };

  const name = clean(input.name, PROFILE_NAME_MAX);
  if (!name) return { ok: false, error: "bad_name" };
  const avatar = normalizeAvatar(input.avatar);
  if (avatar == null) return { ok: false, error: "bad_avatar" };

  const brief = normalizeBrief({ ...(input.brief as object), ready: true, source: "manual" });
  if (brief.niche.length < 3 || brief.audience.length < 3) {
    return { ok: false, error: "incomplete_brief" };
  }

  return {
    ok: true,
    value: {
      requestKey,
      channelId,
      name,
      avatar,
      brief: {
        niche: brief.niche,
        audience: brief.audience,
        goal: brief.goal,
        rubrics: brief.rubrics,
        formats: brief.formats,
        authorRole: brief.authorRole,
        cta: brief.cta,
        taboo: brief.taboo,
      },
    },
  };
}

export function profileReauthMethod(user: {
  password_hash: string | null;
  tg_id: string | number | null;
  vk_id: string | number | null;
}): "password" | "telegram" | "vk" | "unavailable" {
  if (user.password_hash) return "password";
  if (user.tg_id != null) return "telegram";
  if (user.vk_id != null) return "vk";
  return "unavailable";
}
