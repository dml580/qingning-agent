import { expect, test } from '@playwright/test'

test('统一入口自动注册，重新进入仍显示用户名和密码，已有账号须验证密码', async ({ page }) => {
  const username = `user-${Date.now()}`
  await page.goto('/')
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible()
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations()
    return registrations.length
  })).toBe(0)
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  await expect(page.getByText('今天想聊什么，或者想先处理哪件事？')).toBeVisible()
  await page.request.post('/api/auth/logout')
  await page.reload()
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible()
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible()
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('用户名或密码不正确')
  await page.getByLabel('密码', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  await expect(page.getByText('今天想聊什么，或者想先处理哪件事？')).toBeVisible()
})

test('登录接口异常显示中文提示', async ({ page }) => {
  await page.route('**/api/auth/login', (route) =>
    route.fulfill({ status: 500, body: 'Internal Server Error' }),
  )
  await page.goto('/')
  await page.getByLabel('用户名', { exact: true }).fill('error-user')
  await page.getByLabel('密码', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('服务器暂时出错，请稍后重试')
})

test('登录后左下角显示用户名并可打开账号菜单', async ({ page }) => {
  const username = `menu-${Date.now()}`
  await page.goto('/')
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('密码', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()

  const profile = page.getByRole('button', { name: new RegExp(username) })
  await expect(profile).toBeVisible()
  await profile.click()
  const menu = page.getByRole('menu', { name: '账号与设置' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '模型设置' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '隐私与使用说明' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '退出登录' })).toBeVisible()
  await expect(page.getByRole('menu', { name: '选择主题模式' })).toHaveCount(0)
  await menu.getByRole('menuitem', { name: /主题模式/ }).click()
  const themeMenu = page.getByRole('menu', { name: '选择主题模式' })
  await expect(themeMenu).toBeVisible()
  await expect(themeMenu.getByRole('menuitemradio')).toHaveCount(3)
})
