import { expect, test } from '@playwright/test'

test('聊天创建的提醒在提醒页可见，刷新后仍然存在', async ({ page }) => {
  // No API routes are mocked: chat → SSE/tool → SQLite → reminder query.
  const status = await page.request.get('/api/auth/status')
  const { configured } = await status.json()
  const login = await page.request.post(`/api/auth/${configured ? 'login' : 'setup'}`, {
    data: { username: 'reminder-e2e', password: 'qingning-e2e-only' },
  })
  expect(login.ok()).toBeTruthy()

  await page.goto('/')
  await expect(page.getByText('今天想聊什么，或者想先处理哪件事？')).toBeVisible()
  await page.evaluate(() => {
    ;(window as typeof window & { userBubbleWithoutHeader?: boolean; agentPlanSeen?: boolean }).userBubbleWithoutHeader = false
    ;(window as typeof window & { agentPlanSeen?: boolean }).agentPlanSeen = false
    new MutationObserver(() => {
      const bubble = document.querySelector('.bubble.user')
      if (bubble && !bubble.querySelector('header')) {
        ;(window as typeof window & { userBubbleWithoutHeader?: boolean }).userBubbleWithoutHeader = true
      }
      if (document.querySelector('.agent-plan')) {
        ;(window as typeof window & { agentPlanSeen?: boolean }).agentPlanSeen = true
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.locator('.composer textarea').fill('2030-12-18 09:30 提醒我买猫粮')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { userBubbleWithoutHeader?: boolean }).userBubbleWithoutHeader,
  )).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { agentPlanSeen?: boolean }).agentPlanSeen,
  )).toBe(true)

  // A successful tool write currently opens the reminder panel automatically.
  await expect(page.getByRole('heading', { name: '提醒面板' })).toBeVisible()
  const card = page.locator('.reminder-card').filter({ hasText: '买猫粮' })
  await expect(card).toHaveCount(1)
  await expect(card.locator('strong')).toHaveText('买猫粮')
  await expect(card).toContainText('2030-12-18 09:30')
  await expect(card.getByRole('button', { name: '完成', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '删除', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.getByTitle('切换到提醒面板', { exact: true }).click()
  await expect(card).toHaveCount(1)
  await page.reload()
  await page.getByTitle('切换到提醒面板', { exact: true }).click()
  await expect(card).toHaveCount(1)
  await expect(card.locator('strong')).toHaveText('买猫粮')
  await expect(card).toContainText('2030-12-18 09:30')
  await expect.poll(async () => {
    const runs = await (await page.request.get('/api/agent/runs')).json()
    return runs.some((run: { steps: Array<{ skill_name: string }> }) =>
      run.steps.some((step) => step.skill_name === 'manage_reminder'),
    )
  }).toBe(true)
})
