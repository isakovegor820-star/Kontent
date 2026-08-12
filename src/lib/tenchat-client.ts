export type TenChatExportFailure = {
  title: string;
  body: string;
};

export function tenChatExportFailure(code: string | null | undefined): TenChatExportFailure {
  switch (code) {
    case "access_denied":
      return {
        title: "Недостаточно прав для экспорта",
        body: "Скачать пакет для ручной публикации может владелец или публикатор проекта.",
      };
    case "tenchat_text_invalid":
      return {
        title: "Проверь текст",
        body: "Для пакета нужен непустой текст длиной до 30 000 символов.",
      };
    case "tenchat_asset_not_found":
      return {
        title: "Медиа недоступно",
        body: "Прикреплённый файл не найден в текущем проекте. Выбери его заново или скачай пакет без медиа.",
      };
    case "tenchat_asset_0_unsupported_type":
    case "tenchat_asset_1_unsupported_type":
    case "tenchat_asset_2_unsupported_type":
    case "tenchat_asset_3_unsupported_type":
    case "tenchat_asset_4_unsupported_type":
    case "tenchat_asset_5_unsupported_type":
    case "tenchat_asset_6_unsupported_type":
    case "tenchat_asset_7_unsupported_type":
    case "tenchat_asset_8_unsupported_type":
    case "tenchat_asset_9_unsupported_type":
      return {
        title: "Формат медиа не поддержан экспортом",
        body: "Скачай пакет без этого файла и добавь медиа вручную в официальном приложении TenChat.",
      };
    case "tenchat_package_too_large":
      return {
        title: "Пакет слишком большой",
        body: "Уменьши размер вложений или добавь их вручную после скачивания текста.",
      };
    case "tenchat_asset_count_invalid":
      return {
        title: "Слишком много вложений",
        body: "В один пакет можно добавить до 10 файлов. Остальные добавь вручную в официальном приложении TenChat.",
      };
    case "rate_limited":
      return {
        title: "Слишком много экспортов",
        body: "Подожди немного и повтори скачивание. Публикация в TenChat не запускалась.",
      };
    default:
      return {
        title: "Не удалось подготовить пакет",
        body: "Текст остался в редакторе. Попробуй ещё раз — в TenChat ничего не отправлялось.",
      };
  }
}

export function tenChatDownloadFileName(contentDisposition: string | null): string {
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(contentDisposition || "")?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to a stable local name below.
    }
  }
  return "aurora-tenchat-package.zip";
}
