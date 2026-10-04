"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/brand";
import styles from "./bento.module.css";

/**
 * Шапка: плавающая пилюля, как в утверждённом макете.
 *
 * Отличия от макета — только там, где этого требует продукт: ссылки ведут на
 * существующие маршруты (`/login`, `/register`), а кнопка меню связана с панелью
 * через `aria-controls`, поэтому её находят и скринридер, и тест главной.
 * Тень появляется после прокрутки — единственная реакция шапки на страницу.
 */

const LINKS = [
  { href: "#fit", label: "Кому это нужно" },
  { href: "#features", label: "Что умеет" },
  { href: "#how", label: "Как работает" },
  { href: "#standard", label: "Стандарт" },
  { href: "#access", label: "Доступ" },
] as const;

export function Nav() {
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setStuck((window.scrollY || 0) > 14);
    };
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    toggleRef.current?.focus();
  }

  return (
    <>
      <header className={styles.nav} data-stuck={stuck ? "yes" : "no"} onKeyDown={handleKeyDown}>
        <div className={styles.navInner}>
          <a className={styles.brand} href="#top" aria-label="Аврора — на главную">
            <Logo size={30} decorative />
            Аврора
          </a>

          <nav className={styles.navLinks} aria-label="Разделы">
            {LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>

          <div className={styles.navAct}>
            <a className={styles.navLogin} href="/login">
              Войти
            </a>
            <a className={`${styles.btn} ${styles.btnGrape}`} href="/register">
              Начать
              <ArrowRight aria-hidden="true" />
            </a>
            <button
              ref={toggleRef}
              type="button"
              className={styles.navToggle}
              aria-label={open ? "Закрыть меню" : "Открыть меню"}
              aria-expanded={open}
              aria-controls="landing-mobile-menu"
              onClick={() => setOpen((current) => !current)}
            >
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <div className={styles.mobile} id="landing-mobile-menu" data-open={open ? "yes" : "no"}>
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
            {link.label}
          </a>
        ))}
        <a className={`${styles.btn} ${styles.btnGrape}`} href="/register" onClick={() => setOpen(false)}>
          Начать
        </a>
      </div>
    </>
  );
}
