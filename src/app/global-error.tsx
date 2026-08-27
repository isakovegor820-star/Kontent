"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ru">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f7f8fb" }}>
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
            color: "#172033",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 28 }}>Что-то сломалось</h1>
          <p style={{ margin: 0, maxWidth: 520, lineHeight: 1.6 }}>
            Ошибка уже отправлена в систему мониторинга. Обновите страницу — ваши данные
            останутся на месте.
          </p>
          {error.digest ? (
            <p style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>
              Код ошибки: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              justifySelf: "center",
              border: 0,
              borderRadius: 10,
              padding: "12px 18px",
              background: "#2563ff",
              color: "white",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Обновить страницу
          </button>
        </main>
      </body>
    </html>
  );
}
