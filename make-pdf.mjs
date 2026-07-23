// Экспорт презентации в PDF: каждый слайд — страница 16:10.
import { chromium } from "playwright-core";
const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(
  "file:///Users/egor/mvp%20and%20prod/presentation-aurora.html#1/14",
  { waitUntil: "networkidle" }
);
// В печатном режиме показать все слайды (print-CSS делает их потоком)
await page.emulateMedia({ media: "print" });
await page.waitForTimeout(1500);
await page.pdf({
  path: "/Users/egor/mvp and prod/presentation-aurora.pdf",
  width: "1440px",
  height: "900px",
  printBackground: true,
  pageRanges: "",
  margin: { top: 0, bottom: 0, left: 0, right: 0 },
});
await browser.close();
console.log("pdf done");
