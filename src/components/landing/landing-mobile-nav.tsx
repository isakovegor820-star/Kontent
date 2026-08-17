"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { Menu, X } from "lucide-react";
import styles from "./reference-landing.module.css";

const links = [
  { href: "#product", label: "Продукт" },
  { href: "#features", label: "Возможности" },
  { href: "#how", label: "Как работает" },
  { href: "#integrations", label: "Интеграции" },
  { href: "#access", label: "Доступ" },
] as const;

export function LandingMobileNav() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function closeMenu() {
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    closeMenu();
    triggerRef.current?.focus();
  }

  return (
    <div className={styles.mobileNav} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.mobileNavButton}
        aria-label={open ? "Закрыть меню" : "Открыть меню"}
        aria-expanded={open}
        aria-controls="landing-mobile-menu"
        onClick={() => setOpen((current) => !current)}
      >
        {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        <span>Меню</span>
      </button>
      <nav
        id="landing-mobile-menu"
        className={styles.mobileNavMenu}
        aria-label="Мобильная навигация"
        hidden={!open}
      >
        {links.map((link) => (
          <a key={link.href} href={link.href} onClick={closeMenu}>
            {link.label}
          </a>
        ))}
        <a href="/login" onClick={closeMenu}>Войти</a>
      </nav>
    </div>
  );
}
