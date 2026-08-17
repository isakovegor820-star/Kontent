import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";

import { BotWorkspace } from "./workspace";

export const metadata: Metadata = {
  title: "Аврора в Telegram",
  description: "Компактный кабинет публикаций, согласований и проблем Авроры.",
};

export default async function BotPage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <>
    <Script
      src="https://telegram.org/js/telegram-web-app.js"
      strategy="beforeInteractive"
      nonce={nonce}
    />
    <BotWorkspace />
  </>;
}
