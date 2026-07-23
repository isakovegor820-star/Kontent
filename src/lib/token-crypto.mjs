// Шифрование токенов третьих сервисов (VK и будущих) перед сохранением в БД.
// Стандарт проекта (РЕВЬЮ-ТЗ, стр. 266/423): AES-256-GCM, AAD = user_id || provider
// (украденная строка не расшифруется в контексте другого пользователя/провайдера),
// key_id с первого дня (ротация ключа без миграции данных), мастер-ключ из env
// (не в git, не в образе, не в том же бэкапе, что БД).
//
// Модуль намеренно чистый (только node:crypto, без pg/redis) и в ESM — его импортируют
// И TS-роуты (через @/lib/token-crypto.mjs), И .mjs-воркер (./src/lib/token-crypto.mjs).
// Алгоритм один на всех — никакого дублирования крипто между воркером и роутами.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGO = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";

/** 32-байтный ключ из мастер-секрета произвольной длины (sha256). */
function deriveKey(masterKey) {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

// Ключ НЕ кэшируем на уровне модуля: читаем env на каждый вызов. Операции редкие
// (подключение канала / публикация), sha256 дёшев, а зато смена TOKENS_MASTER_KEY
// видна сразу и тестируется без перезагрузки модуля.
function getMasterKey() {
  const secret = process.env.TOKENS_MASTER_KEY;
  if (!secret) {
    throw new Error("TOKENS_MASTER_KEY не задан — токены сообществ шифровать нечем");
  }
  return deriveKey(secret);
}

// key_id кладём в конверт с первого дня: при будущей ротации ключей расшифровка
// сможет выбрать нужный ключ по id, не перешифровывая все строки разом.
function getKeyId() {
  return process.env.TOKENS_KEY_ID || "1";
}

function aadOf({ userId, provider }) {
  return `${userId}:${provider}`;
}

/**
 * Шифрует токен. Конверт: `v1:<keyId>:<ivHex>:<authTagHex>:<ciphertextHex>`.
 * AAD привязывает шифр к владельцу и провайдеру: чужая строка в другом контексте
 * не расшифруется (GCM не сойдётся auth tag).
 */
export function encryptToken(plaintext, ctx) {
  const key = getMasterKey();
  const iv = randomBytes(12); // 96 бит — рекомендованный размер IV для GCM
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aadOf(ctx), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    getKeyId(),
    iv.toString("hex"),
    authTag.toString("hex"),
    ciphertext.toString("hex"),
  ].join(":");
}

/**
 * Расшифровывает токен. Любое несоответствие — другой ключ, чужой user/provider,
 * подменённый шифр или битый конверт — бросает исключение (GCM проверяет целостность).
 */
export function decryptToken(envelope, ctx) {
  const parts = String(envelope).split(":");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
    throw new Error("неверный формат конверта токена");
  }
  const [, , ivHex, authTagHex, ciphertextHex] = parts;
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAAD(Buffer.from(aadOf(ctx), "utf8"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
