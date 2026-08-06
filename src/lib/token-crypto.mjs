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
export class TokenCryptoError extends Error {
  constructor(code) {
    super(code);
    this.name = "TokenCryptoError";
    this.code = code;
  }
}

function validKeyId(value) {
  return /^[a-zA-Z0-9._-]{1,64}$/u.test(value);
}

export function tokenKeyring(env = process.env) {
  const currentSecret = String(env.TOKENS_MASTER_KEY || "");
  const currentKeyId = String(env.TOKENS_KEY_ID || "1");
  if (!currentSecret) throw new TokenCryptoError("token_key_missing");
  if (!validKeyId(currentKeyId)) throw new TokenCryptoError("token_key_id_invalid");
  let oldKeys = {};
  if (String(env.TOKENS_OLD_KEYS || "").trim()) {
    try {
      oldKeys = JSON.parse(String(env.TOKENS_OLD_KEYS));
    } catch {
      throw new TokenCryptoError("token_old_keys_invalid");
    }
  }
  if (!oldKeys || typeof oldKeys !== "object" || Array.isArray(oldKeys)) {
    throw new TokenCryptoError("token_old_keys_invalid");
  }
  const keys = new Map();
  for (const [keyId, secret] of Object.entries(oldKeys)) {
    if (!validKeyId(keyId) || typeof secret !== "string" || !secret) {
      throw new TokenCryptoError("token_old_keys_invalid");
    }
    keys.set(keyId, deriveKey(secret));
  }
  keys.set(currentKeyId, deriveKey(currentSecret));
  return { currentKeyId, keys };
}

export function tokenEnvelopeKeyId(envelope) {
  const parts = String(envelope).split(":");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION || !validKeyId(parts[1])) {
    throw new TokenCryptoError("token_envelope_invalid");
  }
  return parts[1];
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
  const { currentKeyId, keys } = tokenKeyring();
  const key = keys.get(currentKeyId);
  const iv = randomBytes(12); // 96 бит — рекомендованный размер IV для GCM
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aadOf(ctx), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    currentKeyId,
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
  const keyId = tokenEnvelopeKeyId(envelope);
  const [, , ivHex, authTagHex, ciphertextHex] = parts;
  if (!/^[a-f0-9]{24}$/iu.test(ivHex)
    || !/^[a-f0-9]{32}$/iu.test(authTagHex)
    || !/^(?:[a-f0-9]{2})+$/iu.test(ciphertextHex)) {
    throw new TokenCryptoError("token_envelope_invalid");
  }
  const key = tokenKeyring().keys.get(keyId);
  if (!key) throw new TokenCryptoError("token_key_unknown");
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAAD(Buffer.from(aadOf(ctx), "utf8"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new TokenCryptoError("token_authentication_failed");
  }
}
