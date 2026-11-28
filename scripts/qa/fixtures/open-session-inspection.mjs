// Exercise the same compact card and conversation menus that are available in the app.
export async function openSessionInspection(page) {
  const card = page.getByRole('complementary', { name: '会话详情', exact: true });
  if (await card.isVisible()) {
    const expand = card.getByRole('button', { name: '展开会话详情' });
    if (await expand.isVisible()) await expand.click();
  } else {
    const row = page.locator('.session-row-shell:has(.session-row.is-active)');
    if (await row.isVisible()) {
      await row.hover();
      await row.getByRole('button', { name: /的更多操作$/ }).click();
    } else {
      const chats = page.locator('.document-tab [role="tab"]:has(.lucide-message-circle)');
      const selected = chats.and(page.locator('[aria-selected="true"]'));
      await (await selected.isVisible() ? selected : chats.last()).click({ button: 'right' });
    }
    await page.getByRole('menuitem', { name: '查看会话详情' }).click();
  }
  await card.getByRole('tablist').waitFor();
  return card;
}
