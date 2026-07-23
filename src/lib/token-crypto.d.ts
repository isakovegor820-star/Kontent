// Типы для token-crypto.mjs (чистый ESM-модуль шифрования токенов).
// Позволяют TS-роутам импортировать @/lib/token-crypto.mjs со строгой типизацией.

export interface TokenCryptoContext {
  /** Владелец токена (users.id). Часть AAD — чужая строка в другом контексте не расшифруется. */
  userId: number | string;
  /** Провайдер токена ("vk" и т.п.). Вторая часть AAD. */
  provider: string;
}

/** Шифрует токен в конверт `v1:<keyId>:<iv>:<authTag>:<ciphertext>`. */
export function encryptToken(plaintext: string, ctx: TokenCryptoContext): string;

/** Расшифровывает токен; любое несоответствие (ключ/AAD/целостность) — throw. */
export function decryptToken(envelope: string, ctx: TokenCryptoContext): string;
