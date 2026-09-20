export type KnowledgeStatus = {
  kind?: string;
  status: 'pending' | 'ready' | 'error';
  chunks: number;
  semantic_ready?: boolean;
  text_indexed_at?: string | null;
  embedding_error_code?: string | null;
  embedding_attempts?: number;
  next_retry_at?: string | null;
};
const errors: Record<string, string> = {
  embedding_not_configured: 'Семантический поиск не настроен. Нужна помощь администратора.',
  embedding_auth: 'Провайдер отклонил доступ. Администратору нужно проверить подключение.',
  embedding_model_unavailable: 'Модель поиска недоступна. Нужна помощь администратора.',
  embedding_rate_limit: 'Провайдер ограничил запросы.',
  embedding_provider_unavailable: 'Сервис семантического поиска временно недоступен.',
  embedding_request_rejected: 'Провайдер отклонил обработку. Нужна помощь администратора.',
  embedding_dimension_mismatch: 'Модель поиска вернула несовместимый результат. Нужна помощь администратора.',
  embedding_invalid_vector: 'Модель поиска вернула некорректный результат.',
  embedding_invalid_response: 'Сервис поиска вернул некорректный ответ.',
  embedding_network: 'Нет связи с сервисом семантического поиска.',
  embedding_timeout: 'Сервис семантического поиска не ответил вовремя.',
};
export function knowledgeStatusMessage(source: KnowledgeStatus): string {
  if (source.status === 'error') return 'Материал не удалось обработать. Проверьте текст и добавьте его заново.';
  if (!source.text_indexed_at && source.status !== 'ready') return 'Материал сохранён и ждёт обработки.';
  if (source.kind === 'channel') return 'Образцы стиля доступны генерации. Они не используются как источник фактов.';
  if (source.semantic_ready) return 'Материал доступен для текстового и семантического поиска.';
  const available = 'Текст доступен для поиска и генерации.';
  const code = source.embedding_error_code;
  if (code && errors[code]) return `${available} ${errors[code]} ${source.next_retry_at && (source.embedding_attempts ?? 0) < 5 ? 'Повтор запланирован.' : 'Автоматические попытки остановлены.'}`;
  if ((source.embedding_attempts ?? 0) >= 5 && (!source.next_retry_at || Date.parse(source.next_retry_at) <= Date.now())) return `${available} Семантический поиск не подготовлен. Повторите обработку.`;
  return `${available} Семантический поиск готовится.`;
}

export function knowledgeNeedsPolling(source: KnowledgeStatus): boolean {
  if (source.status === 'pending') return true;
  if (source.semantic_ready || source.status === 'error') return false;
  if (!source.embedding_error_code) return true; // legacy index or changed embedding model
  return Boolean(source.next_retry_at) && ((source.embedding_attempts ?? 0) < 5 || Date.parse(source.next_retry_at!) > Date.now());
}
export function knowledgeCanRetry(source: KnowledgeStatus): boolean {
  if (source.semantic_ready || source.status === 'error' || !source.embedding_error_code) return false;
  const processing = ['embedding_processing', 'embedding_retry_requested'].includes(source.embedding_error_code);
  return !processing || Boolean(source.next_retry_at && Date.parse(source.next_retry_at) <= Date.now());
}
