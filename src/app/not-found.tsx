import Link from "next/link";
import { AuroraBackground } from "@/components/aurora-background";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 text-center">
      <AuroraBackground intensity="section" grid grain />

      <div className="relative">
        <Wordmark className="mb-10 justify-center" />

        <p className="display text-[clamp(4rem,14vw,9rem)] text-gradient">404</p>

        <h1 className="mt-4 text-2xl font-extrabold tracking-tight text-text sm:text-3xl">
          Такой страницы нет
        </h1>
        {/* Тон ТЗ 7.5: что случилось, что делать */}
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-text-2">
          Возможно, ссылка устарела или в адресе опечатка. Ничего страшного — вернём тебя на
          главную.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/">
            <Button variant="brand" size="lg">
              На главную
            </Button>
          </Link>
          <Link href="/app/calendar">
            <Button variant="outline" size="lg">
              Открыть платформу
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
