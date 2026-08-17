import type { Metadata } from "next";
import Script from "next/script";

import { BotWorkspace } from "./workspace";

export const metadata: Metadata = {
  title: "Аврора в Telegram",
  description: "Компактный кабинет публикаций, согласований и проблем Авроры.",
};

export default function BotPage() {
  return <>
    <Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" />
    <BotWorkspace />
  </>;
}
