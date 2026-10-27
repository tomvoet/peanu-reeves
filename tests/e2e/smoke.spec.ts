import { expect, test, type Page } from '@playwright/test'
import { twinkle } from '../fixtures/midis'

/** The app ships no songs, so each test imports one through the library's Import MIDI button. */
async function importTwinkle(page: Page): Promise<void> {
  await page.goto('/')
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import MIDI' }).first().click(),
  ])
  await chooser.setFiles({
    name: 'twinkle.mid',
    mimeType: 'audio/midi',
    buffer: Buffer.from(twinkle()),
  })
}

async function openTwinkle(page: Page): Promise<void> {
  await importTwinkle(page)
  await page.getByRole('link', { name: /^Twinkle, Twinkle/ }).click()
}

test('plays a song with the computer keyboard and shows stats', async ({ page }) => {
  await openTwinkle(page)
  await expect(page).toHaveURL(/\/practice\//)

  const play = page.getByTestId('play')
  await expect(play).toBeEnabled({ timeout: 90_000 })
  const faster = page.getByRole('button', { name: 'Faster' })
  for (let i = 0; i < 10; i++) await faster.click()
  await play.click()

  // Upper keyboard row starts at C4: Q = C4, T = G4.
  for (const key of ['KeyQ', 'KeyQ', 'KeyT', 'KeyT']) {
    await page.keyboard.down(key)
    await page.waitForTimeout(150)
    await page.keyboard.up(key)
    await page.waitForTimeout(200)
  }

  const live = page.getByTestId('live-stats')
  await expect(live).toBeVisible()
  const summary = page.getByTestId('pass-summary')
  await expect(summary).toBeVisible({ timeout: 30_000 })
  await expect(summary).toContainText('accuracy')
  await expect(summary.getByRole('listitem')).toHaveCount(4)

  // The missed bars become a drill: a loop with the tempo ramp.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Drill weak bars' }).click()
  await expect(page.getByText(/Drill 1 of 1/).first()).toBeVisible()
  await page.keyboard.press('Space')

  await page.goto('/stats')
  await expect(page.getByRole('cell', { name: '150%' }).first()).toBeVisible()
})

test('wait mode halts until the right notes are played', async ({ page }) => {
  await openTwinkle(page)
  await expect(page.getByTestId('play')).toBeEnabled({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Options' }).click()
  await page.getByRole('radio', { name: 'Auto' }).first().click()
  await page.getByRole('checkbox', { name: /Wait mode/ }).check()
  await page.getByRole('button', { name: 'Close options' }).click()
  await page.getByTestId('play').click()

  const waiting = page.locator('.chip', { hasText: 'Waiting for' })
  for (const key of 'Q Q T T Y Y T R R E E W W Q'.split(' ')) {
    await expect(waiting).toBeVisible()
    await page.keyboard.press(`Key${key}`)
    await expect(waiting).toBeHidden()
  }

  const summary = page.getByTestId('pass-summary')
  await expect(summary).toBeVisible({ timeout: 20_000 })
  await expect(summary.locator('.score')).toHaveText(/100\s*%/)
  await expect(summary).toContainText(/14\s*hit/)
})

test('listen mode plays the song without scoring', async ({ page }) => {
  await openTwinkle(page)
  await page.getByTestId('listen').click()
  await expect(page).toHaveURL(/mode=listen/)
  await expect(page.getByTestId('live-stats')).toHaveCount(0)
  await expect(page.getByTestId('play')).toBeEnabled({ timeout: 60_000 })
  await page.getByTestId('play').click()
  await page.keyboard.press('KeyZ')
  const slider = page.getByRole('slider', { name: 'Position' })
  await expect(slider).not.toHaveAttribute('aria-valuenow', '0', { timeout: 5_000 })
  await page.getByRole('button', { name: 'Options' }).click()
  await page.getByRole('button', { name: 'Practice from here' }).click()
  await expect(page.getByTestId('live-stats')).toBeVisible()
})

test('dragging across the progress bar loops those bars', async ({ page }) => {
  await openTwinkle(page)
  const track = page.getByRole('slider', { name: 'Position' })
  const box = (await track.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width * 0.3, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.45, y, { steps: 5 })
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 5 })
  await page.mouse.up()
  const clear = page.getByRole('button', { name: 'Clear loop' })
  await expect(page.locator('.loop-row')).toContainText(/Loop bars \d+–\d+/)
  await expect(clear).toBeVisible()
  await clear.click()
  await expect(clear).toBeHidden()

  await page.mouse.move(box.x + box.width * 0.45, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, y, { steps: 5 })
  await page.mouse.up()
  await expect(clear).toBeVisible()
  await page.mouse.click(box.x + box.width * 0.9, y)
  await expect(clear).toBeHidden()
  await expect(track).not.toHaveAttribute('aria-valuenow', '0')
})

test('a learned piano key starts playback and stays silent', async ({ page }) => {
  await importTwinkle(page)
  await page.goto('/settings')
  const row = page.locator('.bindings li', { hasText: 'Play / pause' })
  await row.getByRole('button', { name: 'Learn' }).click()
  await expect(row).toContainText('Press a key or pedal')
  await page.keyboard.press('KeyZ')
  await expect(row).toContainText('Key C3')

  await page.getByRole('link', { name: 'Library' }).click()
  await page.getByRole('link', { name: /^Twinkle, Twinkle/ }).click()
  await expect(page.getByTestId('play')).toBeEnabled({ timeout: 60_000 })
  await page.keyboard.press('KeyZ')
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await page.keyboard.press('KeyZ')
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  await expect(page.getByTitle('Wrong notes')).toHaveText(/^0/)
})

test('an empty library explains how to add music', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Add your music' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import MIDI' }).first()).toBeVisible()
})

test('a finished pass is kept as a take to replay and compare', async ({ page }) => {
  await openTwinkle(page)
  await expect(page.getByTestId('play')).toBeEnabled({ timeout: 90_000 })
  const faster = page.getByRole('button', { name: 'Faster' })
  for (let i = 0; i < 10; i++) await faster.click()
  await page.getByTestId('play').click()
  for (const key of ['KeyQ', 'KeyQ', 'KeyT', 'KeyT']) {
    await page.keyboard.press(key)
    await page.waitForTimeout(300)
  }

  const summary = page.getByTestId('pass-summary')
  await expect(summary).toBeVisible({ timeout: 30_000 })
  await expect(summary.getByRole('heading', { name: 'Your take' })).toBeVisible()

  await summary.getByRole('button', { name: /Watch it against the score/ }).click()
  await expect(page.getByRole('button', { name: /^Practice/ }).first()).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Both' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'You' }).click()
  await expect(page.getByRole('radio', { name: 'You' })).toHaveAttribute('aria-checked', 'true')

  await page.getByRole('button', { name: 'Star' }).click()
  await page.getByRole('button', { name: 'Takes' }).click()
  await expect(page.getByText('Starred · kept forever')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('play')).toBeVisible()
})

test('free play records, saves and lists a recording', async ({ page }) => {
  await page.goto('/free')
  await expect(page.getByRole('button', { name: 'Record' })).toBeVisible()

  // R also plays a note on the computer keyboard, so the shortcut needs Alt here.
  await page.keyboard.press('Alt+KeyR')
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  for (const key of ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma']) {
    await page.keyboard.down(key)
    await page.waitForTimeout(120)
    await page.keyboard.up(key)
  }
  await page.keyboard.press('Alt+KeyR')

  await expect(page.getByRole('heading', { name: 'Save recording' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Name' }).fill('Scale test')
  await page.getByRole('button', { name: /Save to Recordings/ }).click()
  await expect(page.getByText(/^Saved recording ·/)).toBeVisible()

  await page.getByRole('link', { name: 'Library' }).click()
  await expect(page.getByRole('heading', { name: /Recordings · 1/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Scale test/ }).first()).toBeVisible()

  // A recording can become a piece, which opens for practice and can be removed again.
  await page
    .getByRole('link', { name: /Scale test/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Practise as a piece' }).click()
  await expect(page).toHaveURL(/\/practice\//)
  await expect(page.getByTestId('play')).toBeVisible()
  await page.getByRole('link', { name: 'Library' }).click()
  const remove = page.getByRole('button', { name: 'Remove Scale test from the library' })
  await remove.click()
  await page.getByRole('button', { name: 'Click again to remove Scale test' }).click()
  await expect(page.getByRole('link', { name: 'Scale test', exact: true })).toHaveCount(0)
})

test('sheet music shows above the falling notes and stays on', async ({ page }) => {
  await openTwinkle(page)
  await expect(page.getByTestId('play')).toBeEnabled({ timeout: 90_000 })
  await expect(page.getByTestId('staff')).toHaveCount(0)
  await page.getByRole('button', { name: 'Notes' }).click()
  await expect(page.getByTestId('staff')).toBeVisible()
  await page.waitForTimeout(400)
  await page.reload()
  await expect(page.getByTestId('staff')).toBeVisible()
})

test('the library reminds about backups once there is practice data', async ({ page }) => {
  await openTwinkle(page)
  const play = page.getByTestId('play')
  await expect(play).toBeEnabled({ timeout: 90_000 })
  const faster = page.getByRole('button', { name: 'Faster' })
  for (let i = 0; i < 10; i++) await faster.click()
  await play.click()
  await page.keyboard.down('KeyQ')
  await page.waitForTimeout(150)
  await page.keyboard.up('KeyQ')
  await expect(page.getByTestId('pass-summary')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('link', { name: 'Library' }).click()
  await expect(page.getByText('No backup yet.')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save backup' }).click()
  expect((await download).suggestedFilename()).toMatch(/^peanu-reeves-\d{4}-\d{2}-\d{2}\.json$/)
  await expect(page.getByText('No backup yet.')).toHaveCount(0)
})
