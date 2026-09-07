/** Adopt a project through its real UI and verify both selector and tab context. */
export async function selectProjectWithSettledReads(page, projectId, {waitFor, settleReads, timeoutMs = 60_000}) {
  if (typeof settleReads !== 'function') throw new TypeError('project selection requires a read-settlement observer');
  const selector = page.getByRole('combobox', {name:'Текущий проект', exact:true}).first();
  await selector.waitFor({state:'visible', timeout:timeoutMs});
  await waitFor(async()=>!await selector.isDisabled(), 'project selector remained disabled', timeoutMs);
  await settleReads(page);
  if(Number(await selector.inputValue())!==projectId) await selector.selectOption(String(projectId));
  await waitFor(async()=>await page.evaluate(key=>Number(sessionStorage.getItem(key)), 'aurora:request-project-id')===projectId
    && Number(await selector.inputValue())===projectId, `tab did not adopt project ${projectId}`, timeoutMs);
  await settleReads(page);
}
