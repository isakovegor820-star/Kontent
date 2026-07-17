// Полигон для скролл-сцены. Не часть лендинга — сюда не ведёт ни одна ссылка.
// Живёт, пока не приедут настоящие клипы; кадры здесь синтетические (testsrc2),
// смотрим на механику скраба, а не на картинку.

import { ScrollScene, type Beat } from "@/components/landing/scroll-scene";

const BEATS: Beat[] = [
  {
    at: 0,
    eyebrow: "21:40, последний клиент ушёл",
    title: "Открываешь редактор — и закрываешь.",
    body: "Барбер. Флористка. Пекарь в пять утра. Восемь человек, восемь одинаковых поражений за вечер.",
  },
  {
    at: 0.42,
    eyebrow: "Курсор мигает",
    title: "Каждый день.",
    body: "Не потому что лень. Потому что после смены в голове нет ни одной свободной мысли, а лента ждёт.",
  },
  {
    at: 0.78,
    eyebrow: "Неделя за 15 минут",
    title: "А теперь подними голову.",
    body: "Тот же вечер, тот же человек. Только телефон в кармане, а пост выйдет завтра в десять — сам.",
  },
];

export default function ScrollTestPage() {
  return (
    <main className="bg-bg">
      <section className="grid h-dvh place-items-center px-6 text-center">
        <div>
          <h1 className="display text-[clamp(28px,5vw,52px)] text-text">Крути вниз ↓</h1>
          <p className="mt-3 text-[14px] text-text-3">
            Полигон скраба. Кадры синтетические — смотрим на механику.
          </p>
        </div>
      </section>

      <ScrollScene
        concept="02-cursor"
        frames={48}
        beats={BEATS}
        alt="Восемь человек в конце рабочего дня открывают редактор поста и закрывают его, так ничего и не написав"
      />

      <section className="grid h-dvh place-items-center px-6 text-center">
        <p className="max-w-md text-[15px] text-text-2">
          Дальше шла бы следующая сцена. Скролл перемотал 48 кадров, снятых одним клипом.
        </p>
      </section>
    </main>
  );
}
