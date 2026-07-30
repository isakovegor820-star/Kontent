// Общий контракт медиагенерации для Next API и worker.mjs.
// Здесь нет сетевых вызовов: только allowlist параметров и безопасная сборка payload.

export const MEDIA_QUEUE = "media-generation";

export const MEDIA_MODELS = Object.freeze({
  image: Object.freeze({
    flux: Object.freeze({
      id: "flux",
      label: "Flux · быстро",
      aspectRatios: Object.freeze(["1:1", "3:4", "9:16", "16:9"]),
      defaultAspectRatio: "1:1",
      qualities: Object.freeze(["low", "medium"]),
      defaultQuality: "medium",
    }),
    "gpt-image-2": Object.freeze({
      id: "gpt-image-2",
      label: "GPT Image 2 · качество",
      aspectRatios: Object.freeze(["1:1", "2:3", "3:2"]),
      defaultAspectRatio: "1:1",
      qualities: Object.freeze(["low", "medium"]),
      defaultQuality: "medium",
    }),
  }),
  video: Object.freeze({
    "veo-3.1": Object.freeze({
      id: "veo-3.1",
      label: "Veo 3.1",
      aspectRatios: Object.freeze(["9:16", "16:9"]),
      defaultAspectRatio: "9:16",
      seconds: Object.freeze([4, 6, 8]),
      defaultSeconds: 6,
    }),
  }),
});

export const MEDIA_STYLES = Object.freeze({
  natural: "естественная съёмка, реалистичный свет, правдоподобные материалы",
  editorial: "редакционная фотография, собранная композиция, выразительная типографическая пауза",
  minimal: "минимализм, один главный объект, чистый фон, минимум визуального шума",
  cinematic: "кинематографичный кадр, выразительный свет, контролируемое движение камеры",
  product: "чистая предметная съёмка, точная форма объекта, коммерческая подача без логотипов",
  illustration: "современная цифровая иллюстрация, цельные формы, аккуратная детализация",
});

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/i;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

export function validateMediaInput(raw) {
  const kind = raw?.kind === "video" ? "video" : raw?.kind === "image" ? "image" : null;
  if (!kind) return { ok: false, error: "bad_kind" };

  const prompt = clean(raw?.prompt, 2000);
  if (prompt.length < 5) return { ok: false, error: "short_prompt" };

  const models = MEDIA_MODELS[kind];
  const fallbackModel = kind === "image" ? "flux" : "veo-3.1";
  const model = typeof raw?.model === "string" && models[raw.model] ? raw.model : fallbackModel;
  const preset = models[model];
  const aspectRatio = preset.aspectRatios.includes(raw?.aspectRatio)
    ? raw.aspectRatio
    : preset.defaultAspectRatio;
  const style = Object.hasOwn(MEDIA_STYLES, raw?.style) ? raw.style : "natural";
  const negativePrompt = clean(raw?.negativePrompt, 600);
  const niche = clean(raw?.niche, 120);
  const tone = clean(raw?.tone, 120);

  if (kind === "image") {
    const quality = preset.qualities.includes(raw?.quality) ? raw.quality : preset.defaultQuality;
    return {
      ok: true,
      value: { kind, prompt, model, aspectRatio, quality, style, negativePrompt, niche, tone },
    };
  }

  const seconds = preset.seconds.includes(Number(raw?.seconds))
    ? Number(raw.seconds)
    : preset.defaultSeconds;
  return {
    ok: true,
    value: { kind, prompt, model, aspectRatio, seconds, style, negativePrompt, niche, tone },
  };
}

export function buildNavyMediaPayload(generation) {
  const styleText = MEDIA_STYLES[generation.style] || MEDIA_STYLES.natural;
  const context = [
    generation.niche ? `Тематика автора: ${generation.niche}.` : "",
    generation.tone ? `Характер подачи: ${generation.tone}.` : "",
  ].filter(Boolean).join(" ");
  const prompt = [
    generation.kind === "video" ? "Создай короткое видео." : "Создай изображение.",
    `Задача пользователя: ${generation.prompt}`,
    context,
    `Визуальный стиль: ${styleText}.`,
    "Не добавляй факты, названия, цифры, логотипы или обещания, которых нет в задаче.",
  ].filter(Boolean).join(" ");

  const payload = {
    model: generation.model,
    prompt,
    aspect_ratio: generation.aspect_ratio,
    sync: false,
    response_format: "url",
  };
  if (generation.negative_prompt) payload.negative_prompt = generation.negative_prompt;
  if (generation.kind === "image") payload.quality = generation.quality || "medium";
  if (generation.kind === "video") payload.seconds = Number(generation.seconds) || 6;
  return payload;
}

export function assertSafeMediaUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || PRIVATE_HOST.test(url.hostname)) throw new Error("unsafe_media_url");
  return url;
}

export function detectMediaMime(buffer, header, kind) {
  const declared = String(header || "").split(";")[0].trim().toLowerCase();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
  const detected =
    bytes[0] === 0x89 && ascii(1, 4) === "PNG" ? "image/png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
        : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp"
          : ascii(4, 8) === "ftyp" ? "video/mp4"
            : null;
  const mime = detected || (declared.startsWith(`${kind}/`) ? declared : null);
  if (!mime || !mime.startsWith(`${kind}/`)) throw new Error("bad_media_type");
  return mime;
}

