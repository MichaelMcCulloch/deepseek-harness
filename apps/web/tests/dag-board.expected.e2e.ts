import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/session/dag-tool-transcript/session.v3.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/dag-board', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/dag-board/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'dag-board-web-snapshot'

describe.skipIf(MODE === 'record')('web snapshot: DAG board', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.locator('[data-dag-dock]').waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows counts and expands the topological node list', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-dag-board'))
    const dock = page.locator('[data-dag-dock]')
    await expect.poll(() => dock.getAttribute('open')).toBeNull()
    await dock.locator('summary').click()
    await expect.poll(() => dock.getAttribute('open')).not.toBeNull()
    await dock.getByText('prepare: Prepare the implementation', { exact: true }).waitFor()
    await dock.getByText('verify: Verify the implementation', { exact: true }).waitFor()

    const snapshot = await captureStableAria(page, '[data-dag-dock]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
