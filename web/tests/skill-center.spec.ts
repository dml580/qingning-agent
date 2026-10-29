import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/status', (route) => route.fulfill({ json: { configured: true, authenticated: true, user_id: 'skill-user' } }))
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, provider: 'demo', model: null, configured: false } }))
  await page.route('**/api/catalog', (route) => route.fulfill({ json: { modules: [{ id: 'docs', name: '生活助理 Agent', name_en: 'Agent', blurb: '', status: 'available', scenarios: [{ id: 'general', name: '通用', blurb: '', placeholder: '说点什么' }] }] } }))
  await page.route('**/api/sessions?module_id=docs', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/reminders**', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/calendar/status', (route) => route.fulfill({ json: { configured: false, provider: '', calendar_id: '', alert_minutes: 10, guide: '' } }))
  await page.route('**/api/memory', (route) => route.fulfill({ json: { preference: '少油少盐' } }))
  await page.route('**/api/document-captures?limit=30', (route) => route.fulfill({ json: [{ id: 'doc-1', kind: 'contract', title: '脱敏租赁合同', summary: '押金应在 7 个工作日内退还。', created_at: 1, payload: { amounts: [{ text: '押金 13000 元' }], dates: ['2026-11-01'], key_points: ['提前退租需提前 30 日通知'], missing_clauses: ['争议解决'] } }] }))
})

async function openSkills(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /skill-user/ }).click()
  await page.getByRole('menuitem', { name: '能力管理' }).click()
  await expect(page.getByRole('heading', { name: '能力管理' })).toBeVisible()
}

test('敏感删除使用页面内确认卡', async ({ page }) => {
  await page.route('**/api/todos?include_done=true', (route) => route.fulfill({ json: [{ id: 'todo-1', title: '整理发票', due_date: '', done: false }] }))
  await openSkills(page)
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const card = page.getByRole('alertdialog', { name: '删除待办？' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('整理发票')
  await expect(page.getByText('确认删除')).toBeVisible()
})

test('文档详情展示结构化字段', async ({ page }) => {
  await page.route('**/api/todos?include_done=true', (route) => route.fulfill({ json: [] }))
  await openSkills(page)
  await page.getByRole('button', { name: '文档提取', exact: true }).click()
  await page.getByText('脱敏租赁合同').click()
  const detail = page.getByRole('dialog', { name: '脱敏租赁合同' })
  await expect(detail).toContainText('押金 13000 元')
  await expect(detail).toContainText('提前退租需提前 30 日通知')
  await expect(detail).toContainText('争议解决')
})

test('能力数据加载失败显示中文错误状态', async ({ page }) => {
  await page.route('**/api/todos?include_done=true', (route) => route.fulfill({ status: 500, body: 'Internal Server Error' }))
  await openSkills(page)
  await expect(page.locator('.skill-error')).toContainText('能力数据加载失败：服务器暂时出错，请稍后重试')
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible()
})
