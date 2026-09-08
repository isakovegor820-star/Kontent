import { waitForE2e as waitFor } from "./e2e-wait.mjs";

export async function saveE2eComposerDraft({ protection, readVisibleText, readStoredText, timeoutMs }) {
  const saveButton = protection.getByRole("button", { name: /^(Сохранить сейчас|Сохранено)$/u });
  await saveButton.waitFor();
  const alreadySaved = await saveButton.getAttribute("data-loading") !== "true"
    && (await saveButton.textContent())?.trim() === "Сохранено";
  if (!alreadySaved) {
    await waitFor(
      async () => (await protection.locator("summary").textContent())?.includes("Сохранено")
        || await saveButton.isEnabled({ timeout: 500 }).catch(() => false),
      "Composer save button did not become enabled",
      timeoutMs,
    );
    // Autosave can finish while hydration replaces/closes the disclosure.
    const stillNeedsSave = !(await protection.locator("summary").textContent())?.includes("Сохранено")
      && (await saveButton.textContent().catch(() => ""))?.trim() !== "Сохранено";
    if (stillNeedsSave) {
      // Resolve the current node and use its real DOM click atomically. React can
      // replace the button between Playwright's stability check and native click.
      await saveButton.evaluate((button) => button.click());
    }
    await waitFor(async () => {
      const summary = await protection.locator("summary").textContent();
      return summary?.includes("Сохранено") === true;
    }, "Composer save state did not acknowledge the visible text", timeoutMs);
  }
  await waitFor(async () => {
    const storedText = await readStoredText();
    const currentText = await readVisibleText().catch(() => "");
    return storedText === currentText;
  }, "Composer save button did not acknowledge the visible text", 12_000);
}
