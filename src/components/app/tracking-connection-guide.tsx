"use client";

import { useState } from "react";
import { Check, Clipboard, Download, ExternalLink, RefreshCw } from "lucide-react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import type { ProjectTrackingSettings } from "./tracking-settings-section";

export function verificationErrorMessage(code: string | null): string {
  switch (code) {
    case "verification_script_missing":
      return "Код Авроры не найден в HEAD главной страницы. Вставь весь код ниже в настройки сайта, опубликуй изменения и повтори проверку. Код должен быть в исходном HTML, а не добавляться через диспетчер тегов после загрузки.";
    case "verification_file_missing":
      return "Файл не найден (404). Загрузи его в папку .well-known в корне сайта и проверь полный адрес в запасном способе подключения.";
    case "verification_content_mismatch":
      return "Содержимое файла не совпало. Скачай файл заново и замени его на сайте: внутри должна быть только выданная строка, без HTML, пробелов и переноса строки.";
    case "verification_redirect":
      return "Сайт перенаправляет проверку на другой адрес. Сохрани конечный адрес сайта (например, с www) и установи код для этого адреса.";
    case "verification_access_denied":
      return "Сайт запрещает доступ (401/403). Разреши открывать страницу или проверочный файл без входа в аккаунт и проверки браузера.";
    default:
      return "Аврора не смогла проверить сайт. Проверь его доступность, HTTPS и ограничения хостинга, затем повтори проверку.";
  }
}

function CopyCode({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState("");
  return <div className="min-w-0 space-y-2">
    <pre tabIndex={0} aria-label={label} className="max-w-full overflow-x-auto rounded-xs border border-line bg-surface p-3 text-[12px] leading-relaxed text-text"><code>{value}</code></pre>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" onClick={async () => {
        try { await navigator.clipboard.writeText(value); setMessage("Скопировано"); }
        catch { setMessage("Не удалось скопировать. Выдели текст выше и скопируй вручную."); }
      }}><Clipboard className="h-4 w-4" aria-hidden />{label}</Button>
      <span role="status" className="text-[12px] text-text-2">{message}</span>
    </div>
  </div>;
}

export function trackingDeveloperInstructions(settings: ProjectTrackingSettings, snippet: string): string {
  return `Однократное подключение сайта к Авроре\nСайт: ${settings.siteOrigin}\n\n1. Вставьте один код в HEAD всех страниц через общие настройки сайта и опубликуйте изменения:\n${snippet}\nКод должен присутствовать в исходном HTML главной страницы, до выполнения JavaScript. Скрипт одновременно содержит уникальный код подтверждения домена и подключает счётчик.\n\n2. Откройте опубликованный сайт в браузере. В Авроре нажмите «Проверить подключение». Сервер сам загрузит страницу и проверит код. Успешное подтверждение сохраняется: повторять его при входе, новой публикации или изменении UTM не нужно. При смене адреса сайта потребуется новый код. Сигнал от браузера сам по себе не подтверждает владение доменом.\n\n3. Однократно подключите события форм. После успешного сохранения заявки на вашем сервере вызовите:\nwindow.AuroraTracking.track("form_submit", "form_submit:" + leadId);\nleadId — реальный постоянный идентификатор заявки, не имя, email или телефон. Полный ключ: 8–128 символов, латинские буквы, цифры, . _ : -. Для повторной отправки той же заявки используйте тот же ключ. Не отправляйте form_submit при открытии формы или ошибке отправки. Для открытия формы используйте form_open; для подтверждённой записи — consultation_booked. Для разных событий нужны разные ключи.\n\n4. Создайте ссылку в Композиторе Авроры, перейдите по ней в браузере и отправьте форму. Проверьте событие в аналитике публикации. Простая ссылка с UTM не содержит токен Авроры: без перехода по ссылке Авроры track возвращает no_attribution. Срок связи с публикацией: ${settings.attributionWindowDays} дней.\n\nЗапасной способ подтверждения, если код добавляется через диспетчер тегов или нельзя изменить HEAD: разместите файл ${settings.verificationFilePath} с точным содержимым без переноса строки:\n${settings.verificationFileContent}\nФайл должен открываться с HTTP 200 без авторизации по адресу:\n${settings.siteOrigin}${settings.verificationFilePath}\nВ настройках Авроры раскройте «Запасной способ: проверочный файл» и нажмите «Подтвердить домен файлом». Счётчик и события форм при этом всё равно устанавливаются один раз.\n`;
}

const downloadClass = buttonClassName({ variant: "outline", size: "sm", className: "h-auto whitespace-normal" });

export function TrackingConnectionGuide({ settings, snippet, canManage, disabled, checking, refreshing, onVerify, onRefresh }: {
  settings: ProjectTrackingSettings;
  snippet: string | null;
  canManage: boolean;
  disabled: boolean;
  checking: boolean;
  refreshing: boolean;
  onVerify: (method: "script" | "file") => void;
  onRefresh: () => void;
}) {
  const connected = Boolean(settings.siteOrigin && settings.publicKey && settings.verificationFileContent);
  const verified = Boolean(settings.verifiedAt && ["active", "paused"].includes(settings.status));
  const verificationUrl = `${settings.siteOrigin}${settings.verificationFilePath}`;
  const signalTime = settings.signalReceivedAt ? new Date(settings.signalReceivedAt).toLocaleString("ru-RU") : null;
  const setup = <div className="min-w-0 space-y-4">
    <p className="text-[13px] leading-relaxed text-text-2">В общих настройках сайта найди «HTML-код в HEAD», вставь код ниже и опубликуй изменения. Он одновременно подтверждает домен и подключает счётчик на страницах сайта.</p>
    {snippet ? <CopyCode key={snippet} label="Скопировать код подключения" value={snippet} /> : null}
    <p className="text-[13px] leading-relaxed text-text-2">Открой опубликованный сайт <a href={settings.siteOrigin!} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-brand underline">{settings.siteOrigin}</a> и нажми кнопку ниже. Аврора сама загрузит страницу с сервера и проверит уникальный код в HEAD.</p>
    {canManage ? <Button type="button" variant="primary" size="sm" className="h-auto whitespace-normal" disabled={disabled} loading={checking} onClick={() => onVerify("script")}><RefreshCw className="h-4 w-4" aria-hidden />{verified ? "Перепроверить код на сайте" : "Проверить подключение"}</Button> : <p className="text-[13px] text-text-2">Запустить проверку подключения может владелец проекта.</p>}
    {settings.verificationErrorCode ? <p role="alert" className="rounded-xs bg-danger-soft p-3 text-[13px] leading-relaxed text-danger-text">{verificationErrorMessage(settings.verificationErrorCode)}</p> : null}
    {settings.verificationCheckedAt ? <p className="text-[12px] text-text-3">Последняя проверка: <time dateTime={settings.verificationCheckedAt}>{new Date(settings.verificationCheckedAt).toLocaleString("ru-RU")}</time></p> : null}
    <details className="text-[13px] leading-relaxed text-text-2">
      <summary className="cursor-pointer py-2 font-semibold">Запасной способ: проверочный файл</summary>
      <div className="mt-2 space-y-3">
        <p>Если код устанавливается через диспетчер тегов или недоступен в исходном HTML, подтверди домен файлом. Скачай файл, создай папку <code>.well-known</code> в корне сайта и загрузи туда файл без изменения названия и содержимого.</p>
        <a className={downloadClass} href={`data:text/plain;charset=utf-8,${encodeURIComponent(settings.verificationFileContent!)}`} download="aurora-tracker-verification.txt"><Download className="h-4 w-4" aria-hidden />Скачать проверочный файл</a>
        <p>По этому адресу должна открываться только строка из файла, без входа в аккаунт, HTML и ошибки 404:</p>
        <a href={verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 max-w-full items-center gap-2 break-all text-brand underline">{verificationUrl}<ExternalLink className="h-4 w-4 shrink-0" aria-hidden /></a>
        <CopyCode label="Скопировать строку" value={settings.verificationFileContent!} />
        {canManage ? <Button type="button" variant="outline" size="sm" className="h-auto whitespace-normal" disabled={disabled} loading={checking} onClick={() => onVerify("file")}>Подтвердить домен файлом</Button> : null}
        <p>Простая загрузка в медиатеку обычно даёт другой адрес. Если платформа не позволяет вставить код в исходный HEAD или разместить файл по этому пути, понадобится помощь поддержки хостинга. UTM и переходы по ссылкам Авроры доступны отдельно.</p>
      </div>
    </details>
    <details className="text-[13px] text-text-2"><summary className="cursor-pointer py-2 font-semibold">Открытый ключ проекта</summary><p className="mb-3">Ключ уже включён в код подключения. Его можно размещать на сайте. Секретные ключи здесь не показываются.</p><CopyCode label="Скопировать ключ" value={settings.publicKey!} /></details>
  </div>;

  return <div className="mt-5 min-w-0 space-y-4">
    {!connected ? <p className="rounded-sm bg-surface-inset p-4 text-[13px] leading-relaxed text-text-2">После сохранения адреса здесь появится один код подключения. Вставь его в настройки сайта один раз — повторять настройку для каждой публикации не потребуется.</p> : <>
      <section aria-label="Подключение одним кодом" className="min-w-0 space-y-4 rounded-sm border border-line p-4 sm:p-5">
        {verified ? <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="flex items-center gap-2 text-[15px] font-bold text-text"><Check className="h-5 w-5 text-success-text" aria-hidden />Домен подтверждён</h4><Badge tone={settings.status === "paused" ? "neutral" : "success"}>{settings.status === "paused" ? "Учёт приостановлен" : "Подключение сохранено"}</Badge></div>
          <p className="break-all text-[14px] font-semibold text-text">{settings.siteOrigin}</p>
          <p className="text-[13px] leading-relaxed text-text-2">Повторять настройку при входе, новой публикации или изменении UTM не нужно. Код остаётся на сайте, подтверждение хранится в Авроре. Новое подтверждение потребуется при смене адреса сайта.</p>
          <p className="text-[12px] text-text-3">Подтверждено: <time dateTime={settings.verifiedAt!}>{new Date(settings.verifiedAt!).toLocaleString("ru-RU")}</time></p>
          <details><summary className="cursor-pointer py-2 text-[13px] font-semibold text-text-2">Код подключения и повторная проверка</summary><div className="mt-3">{setup}</div></details>
        </> : <><h4 className="text-[15px] font-bold text-text">2. Вставь один код и проверь подключение</h4>{setup}</>}
      </section>
      <section aria-label="Состояние счётчика" className="space-y-3 rounded-sm bg-surface-inset p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-[14px] font-bold text-text">Счётчик на сайте</h4><Badge tone={signalTime ? "success" : "neutral"}>{signalTime ? "Сигнал получен" : "Сигналов пока нет"}</Badge></div>
        <p className="text-[13px] leading-relaxed text-text-2">{signalTime ? <>Последний сигнал: <time dateTime={settings.signalReceivedAt!}>{signalTime}</time>. Это подтверждает загрузку кода, но не отправку заявки.</> : "Открой опубликованный сайт в браузере. Пока эта страница открыта, Аврора сама проверяет, появился ли сигнал. Если его нет, проверь публикацию кода и блокировщики запросов."}</p>
        <Button type="button" variant="outline" size="sm" disabled={disabled} loading={refreshing} onClick={onRefresh}><RefreshCw className="h-4 w-4" aria-hidden />Обновить статус</Button>
        {!verified && signalTime ? <p className="text-[12px] text-text-3">Сигнал браузера не заменяет подтверждение домена: нажми «Проверить подключение» выше.</p> : null}
      </section>
      <details className="rounded-sm border border-line p-4 text-[13px] leading-relaxed text-text-2 sm:p-5">
        <summary className="cursor-pointer font-semibold">Учёт заявок — настроить один раз</summary>
        <div className="mt-4 space-y-3">
          <p>Код подключения сам не определяет успешную отправку формы. Разработчик один раз добавляет вызов события после сохранения заявки на вашем сервере. Дальше новые заявки передаются автоматически; повторять настройку для публикаций не нужно.</p>
          <CopyCode label="Скопировать пример события" value={'window.AuroraTracking.track("form_submit", "form_submit:" + leadId);'} />
          <p><code>leadId</code> — реальный постоянный ID заявки. При повторной отправке той же заявки используй тот же ключ, чтобы не создавать дубли. Полный ключ — 8–128 символов: латинские буквы, цифры, точка, подчёркивание, двоеточие или дефис. Не передавай имена, телефоны и email.</p>
          <p><code>form_open</code> — открытие формы; <code>form_submit</code> — успешно сохранённая заявка; <code>consultation_booked</code> — подтверждённая запись. Для разных событий нужны разные ключи. Не отправляй заявку при открытии формы или ошибке отправки.</p>
          <p>Для проверки создай ссылку в Композиторе Авроры, перейди по ней и отправь форму. Проверь переход и событие в аналитике публикации. Заявка связывается с переходом в течение {settings.attributionWindowDays} дней.</p>
          <p>Вызов возвращает Promise: <code>ok: true</code> означает приём события; <code>no_attribution</code> — в браузере нет токена перехода по ссылке Авроры. Обычная ссылка только с UTM-метками не передаёт этот токен.</p>
        </div>
      </details>
      {snippet ? <a className={downloadClass} href={`data:text/plain;charset=utf-8,${encodeURIComponent(trackingDeveloperInstructions(settings, snippet))}`} download="aurora-site-setup.txt"><Download className="h-4 w-4" aria-hidden />Инструкция разработчику</a> : null}
    </>}
  </div>;
}
