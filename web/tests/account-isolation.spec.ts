import { expect, test } from '@playwright/test'

test('不同账号看不到彼此的会话和提醒', async ({ browser, baseURL }) => {
  const suffix = Date.now()
  const alice = await browser.newContext({ baseURL })
  const bob = await browser.newContext({ baseURL })
  const aliceApi = alice.request
  const bobApi = bob.request

  await aliceApi.post('/api/auth/login', {
    data: { username: `alice-${suffix}`, password: 'test-password' },
  })
  const sessionResponse = await aliceApi.post('/api/sessions', {
    data: { title: 'Alice 的私密会话', module_id: 'docs', scenario_id: 'general' },
  })
  expect(sessionResponse.ok()).toBeTruthy()
  const session = await sessionResponse.json()
  const reminderResponse = await aliceApi.post('/api/reminders', {
    data: {
      category: 'medicine',
      title: 'Alice 的私密提醒',
      due_date: '2030-12-18',
      due_time: '09:30',
      note: '',
      notify_browser: false,
    },
  })
  expect(reminderResponse.ok()).toBeTruthy()

  await bobApi.post('/api/auth/login', {
    data: { username: `bob-${suffix}`, password: 'test-password' },
  })
  expect(await (await bobApi.get('/api/sessions?module_id=docs')).json()).toEqual([])
  expect(await (await bobApi.get('/api/reminders?include_done=true')).json()).toEqual([])
  expect(await (await bobApi.get('/api/agent/runs')).json()).toEqual([])
  expect((await bobApi.get(`/api/sessions/${session.id}`)).status()).toBe(404)

  expect((await aliceApi.get(`/api/sessions/${session.id}`)).ok()).toBeTruthy()
  expect(await (await aliceApi.get('/api/reminders?include_done=true')).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Alice 的私密提醒' })]),
  )

  await alice.close()
  await bob.close()
})
