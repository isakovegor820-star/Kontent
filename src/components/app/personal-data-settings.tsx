"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Download, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Card } from "@/components/ui/primitives";

/**
 * «Данные и аккаунт»: выгрузка своих данных и удаление аккаунта.
 *
 * Это права субъекта, а не настройки удобства: доступ к своим данным (ч. 7
 * ст. 14 152-ФЗ) и удаление (ст. 21). До появления раздела Политика и Условия
 * обещали такую возможность, но реализовать её было нечем.
 *
 * Удаление необратимо, поэтому две ступени: сначала осознанное согласие с
 * последствиями в самом разделе, затем подтверждение в диалоге, где фокус по
 * умолчанию стоит на отмене.
 */

type Preview = {
  ok?: boolean;
  error?: string;
  personalProjects?: number;
  /** Проекты, где нужен выбор преемника: без него проект останется без владельца. */
  blockers?: Array<{ id: number; name: string }>;
  /** Проекты без других участников: уйдут вместе с аккаунтом. */
  orphanedProjects?: Array<{ id: number; name: string }>;
  /** Кандидатов считает сервер: передать проект можно только участнику. */
  transferCandidates?: Array<{ userId: number; name: string | null; role: string }>;
};

export function PersonalDataSettings() {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [error, setError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  const [consequencesAccepted, setConsequencesAccepted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [transferTo, setTransferTo] = useState<number | null>(null);
  const [transferOptions, setTransferOptions] = useState<Array<{ userId: number; name: string | null }>>([]);

  const loadPreview = useCallback(async (options: { keepMessage?: boolean } = {}) => {
    // При обновлении после ошибки сообщение не сбрасываем: иначе пользователь
    // видит «ничего не произошло» и повторяет бессмысленное действие.
    if (!options.keepMessage) setError(undefined);
    try {
      const response = await fetch("/api/settings/account-deletion", { headers: { accept: "application/json" } });
      const body = (await response.json().catch(() => null)) as Preview | null;
      if (!response.ok || !body?.ok) {
        setError("Не удалось получить состояние аккаунта.");
        return;
      }
      setPreview(body);
      setTransferOptions(body.transferCandidates ?? []);
    } catch {
      setError("Не удалось получить состояние аккаунта. Проверьте соединение.");
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  // Загрузка состояния аккаунта при открытии раздела — тот же приём, что в
  // остальных разделах настроек (см. consents-settings.tsx).
  /* eslint-disable react-hooks/set-state-in-effect -- load account state on mount */
  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const exportData = useCallback(async () => {
    setExporting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/settings/personal-data", { headers: { accept: "application/json" } });
      if (!response.ok) {
        setError("Не удалось подготовить выгрузку. Попробуйте ещё раз.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "aurora-personal-data.json";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExported(true);
    } catch {
      setError("Не удалось подготовить выгрузку. Проверьте соединение.");
    } finally {
      setExporting(false);
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    setDeleting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/settings/account-deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true, ...(transferTo ? { transferSharedTo: transferTo } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (response.ok && body?.ok) {
        // Сессии удалены на сервере: возвращаемся на страницу входа.
        router.push("/login?deleted=1");
        return;
      }
      if (response.status === 409 && body?.error === "shared_project_owner") {
        setError("Сначала передайте командный проект другому участнику — иначе он останется без владельца.");
        await loadPreview({ keepMessage: true });
      } else if (response.status === 422 && body?.error === "invalid_transfer_target") {
        // Повтор не поможет: состав участников изменился, нужен новый выбор.
        setError("Выбранный участник больше не подходит для передачи. Обновите список и выберите заново.");
        setTransferTo(null);
        await loadPreview({ keepMessage: true });
      } else {
        setError("Не удалось удалить аккаунт. Попробуйте позже или напишите в поддержку.");
      }
    } catch {
      setError("Не удалось удалить аккаунт. Проверьте соединение.");
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  }, [loadPreview, router, transferTo]);

  const blockers = preview?.blockers ?? [];
  const orphaned = preview?.orphanedProjects ?? [];
  // Кнопка активна, только когда человек подтвердил последствия и, если нужно,
  // выбрал, кому передать командный проект.
  const canDelete = consequencesAccepted && (blockers.length === 0 || transferTo !== null);

  return (
    <div className="space-y-4" data-setting-target="personal-data">
      <Card className="p-5">
        <div className="flex items-start gap-3">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-text">Выгрузка данных</h3>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-2">
              Файл JSON с данными аккаунта: профиль, согласия, проекты и роли, каналы, публикации и черновики,
              история согласий. Секреты подключений, хеш пароля и служебные журналы в выгрузку не входят —
              это данные оператора, а не ваши.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="secondary" size="sm" loading={exporting} onClick={() => void exportData()}>
                Скачать мои данные
              </Button>
              {exported ? <span className="text-[12px] text-success-text">Файл сформирован</span> : null}
              <Link className="text-[12px] text-info underline underline-offset-2" href="/privacy">
                Что входит в данные
              </Link>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-bold text-text">Удаление аккаунта</h3>
            <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-2">
              Персональные данные стираются, вход прекращается сразу. Личные проекты удаляются вместе с
              аккаунтом. Командный проект остаётся, если в нём есть другие участники: им нужно выбрать нового
              владельца. Если участников не осталось, проект удаляется вместе с содержимым — черновиками,
              материалами и приглашениями.
            </p>

            {loadingPreview ? (
              <p className="mt-3 text-[13px] text-text-2">Проверяем состояние аккаунта…</p>
            ) : (
              <ul className="mt-3 space-y-1 text-[13px] text-text-2">
                <li>
                  Личных проектов к удалению:{" "}
                  <strong className="text-text">{preview?.personalProjects ?? 0}</strong>
                </li>
                {blockers.length ? (
                  <li className="text-danger-text">
                    Командные проекты без другого владельца: {blockers.map((item) => item.name).join(", ")}.
                    Нужно выбрать, кому передать владение.
                  </li>
                ) : null}
                {orphaned.length ? (
                  <li>
                    Командные проекты без других участников: {orphaned.map((item) => item.name).join(", ")}. Других
                    участников в них нет, поэтому они удалятся вместе с аккаунтом.
                  </li>
                ) : null}
              </ul>
            )}

            {blockers.length && transferOptions.length ? (
              <label className="mt-3 block text-[13px] text-text-2">
                Передать владение
                <select
                  className="mt-1 min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text sm:text-[14px]"
                  value={transferTo ?? ""}
                  onChange={(event) => setTransferTo(event.target.value ? Number(event.target.value) : null)}
                >
                  <option value="">Выберите участника</option>
                  {transferOptions.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.name ?? `Участник ${member.userId}`}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {blockers.length && !transferOptions.length && !loadingPreview ? (
              <p className="mt-3 rounded-sm bg-fire-soft p-3 text-[13px] leading-relaxed text-fire-text">
                В проектах, которым нужен новый владелец, нет общего участника, которому можно передать все сразу.
                Пригласите участника в каждый такой проект («Настройки → Проект») или передайте проекты по одному
                через раздел команды, а затем возвращайтесь к удалению аккаунта.
              </p>
            ) : null}

            <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] leading-relaxed text-text-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0"
                checked={consequencesAccepted}
                onChange={(event) => setConsequencesAccepted(event.target.checked)}
              />
              <span>
                Понимаю, что данные будут стёрты, личные проекты удалены, а вход в аккаунт прекратится.
              </span>
            </label>

            <div className="mt-3">
              <Button
                variant="danger"
                size="sm"
                disabled={loadingPreview || !canDelete}
                onClick={() => setConfirmOpen(true)}
              >
                Удалить аккаунт
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {error ? (
        <p role="alert" className="rounded-sm bg-danger-soft p-3 text-[13px] text-danger-text">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Удалить аккаунт навсегда?"
        description={
          orphaned.length
            ? "Персональные данные будут стёрты, сессии завершены, личные проекты удалены. Командные проекты без других участников тоже удалятся вместе с содержимым. Отменить это нельзя."
            : "Персональные данные будут стёрты, сессии завершены, личные проекты удалены. Отменить это нельзя."
        }
        confirmLabel="Удалить аккаунт"
        busy={deleting}
        onCancel={() => {
          if (!deleting) setConfirmOpen(false);
        }}
        onConfirm={() => void deleteAccount()}
      />
    </div>
  );
}
