import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/status', async (route) => {
    await route.fulfill({
      json: { configured: true, authenticated: true },
    })
  })
  await page.route('**/api/health', async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        provider: 'demo',
        provider_label: '演示模式',
        model: 'seed-demo',
        configured: false,
      },
    })
  })
  await page.route('**/api/catalog', async (route) => {
    await route.fulfill({
      json: {
        modules: [
          {
            id: 'docs',
            name: '生活助理 Agent',
            name_en: 'Agent',
            blurb: 'docs',
            status: 'available',
            scenarios: [
              {
                id: 'general',
                name: '通用',
                blurb: 'general',
                placeholder: '说点什么',
              },
            ],
          },
        ],
      },
    })
  })
  await page.route('**/api/sessions?module_id=docs', async (route) => {
    await route.fulfill({ json: [] })
  })
  await page.route('**/api/reminders**', async (route) => {
    const url = route.request().url()
    if (url.includes('/due')) {
      await route.fulfill({
        json: {
          today: '2026-10-27',
          items: [
            {
              id: 'r1',
              category: 'medicine',
              title: '一分钟之后提醒我',
              note: '',
              due_date: '2026-10-27',
              due_time: '12:59',
              done: false,
              notify_browser: true,
              created_at: 1,
              updated_at: 1,
            },
          ],
        },
      })
      return
    }
    await route.fulfill({
      json: [
        {
          id: 'r1',
          category: 'medicine',
          title: '一分钟之后提醒我',
          note: '',
          due_date: '2026-10-27',
          due_time: '12:59',
          done: false,
          notify_browser: true,
          created_at: 1,
          updated_at: 1,
        },
      ],
    })
  })
  await page.route('**/api/calendar/status', async (route) => {
    await route.fulfill({
      json: {
        configured: true,
        provider: 'local',
        calendar_id: '青柠提醒',
        alert_minutes: 10,
        guide: '',
      },
    })
  })
})

test('工作台与提醒页是单选切换', async ({ page }) => {
  await page.goto('/')

  const reminderTab = page.locator('.rail-item.reminder')
  const workspaceTab = page.locator('.rail-item.workspace')

  await expect(reminderTab).toBeVisible()
  await expect(page.getByText('今天想聊什么，或者想先处理哪件事？')).toBeVisible()
  await expect(page.getByRole('heading', { name: '提醒面板' })).not.toBeVisible()

  await reminderTab.click()
  await expect(page.getByRole('heading', { name: '提醒面板' })).toBeVisible()

  await workspaceTab.click()
  await expect(page.getByText('今天想聊什么，或者想先处理哪件事？')).toBeVisible()
  await expect(page.getByRole('heading', { name: '提醒面板' })).not.toBeVisible()
})
