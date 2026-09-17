import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReviewPack } from '../../benchmark/review';
import { renderReviewPage } from '../../benchmark/review-page';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
const pack: ReviewPack = {
  schemaVersion: 1, id: 'browser-review', title: '开发集盲评',
  cases: [0, 1].map(index => ({
    id: 'case-' + index, groupId: 'original-1', configHash: 'd'.repeat(64), prompt: '观察人物轮廓 ' + (index + 1),
    sourceImage: png, width: 2 + index, height: 2, maxColors: 2,
    left: { image: png, hash: 'a'.repeat(64) }, right: { image: png, hash: 'b'.repeat(64) },
  })),
};
const reviewerLabel = '评审者代号（必填，请勿填写真实姓名）';
const likeness = (page: Page) => page.getByRole('group', { name: '1. 哪张图更像原图？' });
const buildability = (page: Page) => page.getByRole('group', { name: '2. 哪张图更适合实际拼豆？' });

// A fulfilled document gives setContent a stable origin without depending on app state.
async function openReview(page: Page, content = renderReviewPage(pack)) {
  await page.route('http://review.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Review test</title>' }));
  await page.goto('http://review.test/');
  await page.setContent(content);
}
async function exportResult(page: Page) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出已完成项 JSON' }).click();
  const download = await downloadPromise;
  return JSON.parse(await readFile((await download.path())!, 'utf8'));
}

test('blind review requires explicit answers and exports only completed cases', async ({ page }) => {
  await openReview(page);
  const exportButton = page.getByRole('button', { name: '导出已完成项 JSON' });
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await expect(page.getByText('原图组数 1', { exact: false })).toBeVisible();
  await expect(exportButton).toBeDisabled();
  await expect(likeness(page).getByLabel('左图', { exact: true })).toBeDisabled();
  await page.getByLabel(reviewerLabel).fill(' reviewer-07 ');
  await likeness(page).getByLabel('左图', { exact: true }).check();
  await expect(exportButton).toBeDisabled();
  await buildability(page).getByLabel('相当', { exact: true }).check();
  await page.getByLabel('失败原因或其他观察（选填）').fill('轮廓清楚，局部碎点偏多。');
  await expect(exportButton).toBeEnabled();
  await page.getByRole('button', { name: '下一项' }).click();
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await likeness(page).getByLabel('都不像', { exact: true }).check();
  await page.getByRole('button', { name: '上一项' }).click();
  await expect(likeness(page).getByLabel('左图', { exact: true })).toBeChecked();
  await expect(buildability(page).getByLabel('相当', { exact: true })).toBeChecked();
  const result = await exportResult(page);
  expect(result).toMatchObject({ schemaVersion: 1, packId: pack.id, evaluatorId: 'reviewer-07', ratings: [
    { caseId: 'case-0', likeness: 'left', buildability: 'tie', note: '轮廓清楚，局部碎点偏多。' },
  ] });
  expect(result.ratings).toHaveLength(1);
  expect(result.ratings[0].elapsedMs).toBeGreaterThan(0);
  expect(Number.isInteger(result.ratings[0].elapsedMs)).toBe(true);
  expect(Object.keys(result).sort()).toEqual(['evaluatorId', 'packId', 'ratings', 'schemaVersion']);
  await expect(page.getByRole('status').filter({ hasText: '已导出 1 / 2 项' })).toBeVisible();
});

test('refresh restores drafts, evaluator, position and accumulated time for this pack only', async ({ page }) => {
  await openReview(page);
  await page.getByLabel(reviewerLabel).fill('reviewer-restore');
  await likeness(page).getByLabel('右图', { exact: true }).check();
  await buildability(page).getByLabel('都不适合', { exact: true }).check();
  const before = await exportResult(page);
  await page.getByRole('button', { name: '下一项' }).click();
  await likeness(page).getByLabel('相当', { exact: true }).check();
  await page.getByLabel('失败原因或其他观察（选填）').fill('尚未完成');
  await page.reload();
  await page.setContent(renderReviewPage(pack));
  await expect(page.getByLabel(reviewerLabel)).toHaveValue('reviewer-restore');
  await expect(page.getByLabel(reviewerLabel)).not.toBeEditable();
  await expect(page.getByRole('heading', { name: '观察人物轮廓 2' })).toBeVisible();
  await expect(likeness(page).getByLabel('相当', { exact: true })).toBeChecked();
  await expect(buildability(page).locator('input:checked')).toHaveCount(0);
  await expect(page.getByLabel('失败原因或其他观察（选填）')).toHaveValue('尚未完成');
  const after = await exportResult(page);
  expect(after.ratings).toHaveLength(1);
  expect(after.ratings[0].elapsedMs).toBeGreaterThanOrEqual(before.ratings[0].elapsedMs);
  await page.setContent(renderReviewPage({ ...pack, id: 'another-pack' }));
  await expect(page.getByLabel(reviewerLabel)).toHaveValue('');
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
});

test('changing evaluators requires clearing prior votes, notes and elapsed time', async ({ page }) => {
  await openReview(page);
  const identity = page.getByLabel(reviewerLabel);
  const notes = page.getByLabel('失败原因或其他观察（选填）');
  const newReview = page.getByRole('button', { name: '开始新评审（清空代号和全部作答）', exact: true });
  await identity.fill('first-reviewer');
  await notes.fill('仅属于第一位评审者的观察');
  await expect(identity).not.toBeEditable();
  await likeness(page).getByLabel('左图', { exact: true }).check();
  await buildability(page).getByLabel('左图', { exact: true }).check();
  // Even an unexpected input event must not reattribute existing votes.
  await identity.evaluate(input => {
    (input as HTMLInputElement).value = 'second-reviewer';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(identity).toHaveValue('first-reviewer');
  await newReview.click();
  await expect(page.getByText('未导出的结果会丢失', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '保留当前评审', exact: true }).click();
  expect((await exportResult(page)).evaluatorId).toBe('first-reviewer');
  await newReview.click();
  await page.getByRole('button', { name: '确认清空并开始新评审', exact: true }).click();
  await expect(identity).toBeEditable();
  await expect(identity).toHaveValue('');
  await expect(notes).toHaveValue('');
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  const cleared = await page.evaluate(id => JSON.parse(localStorage.getItem('beadify-review:' + id)!), pack.id);
  expect(cleared.evaluatorId).toBe('');
  expect(cleared.drafts.every((draft: any) => draft.likeness === null && draft.buildability === null && draft.note === '' && draft.elapsedMs === 0)).toBe(true);
  await identity.fill('second-reviewer');
  await expect(page.getByRole('button', { name: '导出已完成项 JSON' })).toBeDisabled();
  await page.getByRole('button', { name: '下一项' }).click();
  await likeness(page).getByLabel('右图', { exact: true }).check();
  await buildability(page).getByLabel('相当', { exact: true }).check();
  const second = await exportResult(page);
  expect(second).toMatchObject({ evaluatorId: 'second-reviewer', ratings: [{ caseId: 'case-1', likeness: 'right', buildability: 'tie', note: '' }] });
  expect(second.ratings).toHaveLength(1);
  await page.reload();
  await page.setContent(renderReviewPage(pack));
  await expect(identity).toHaveValue('second-reviewer');
  await expect(identity).not.toBeEditable();
  expect((await exportResult(page)).ratings.map((rating: any) => rating.caseId)).toEqual(['case-1']);
});

test('elapsed time excludes hidden intervals', async ({ page }) => {
  await page.addInitScript(() => {
    const clock = { now: 1000, visibility: 'visible' };
    (window as any).__reviewClock = clock;
    Object.defineProperty(performance, 'now', { value: () => clock.now });
    Object.defineProperty(document, 'visibilityState', { get: () => clock.visibility });
  });
  await openReview(page);
  await page.evaluate(() => {
    const clock = (window as any).__reviewClock;
    clock.now = 1500; clock.visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    clock.now = 10000; clock.visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    clock.now = 10100;
  });
  await page.getByLabel(reviewerLabel).fill('timer-test');
  await likeness(page).getByLabel('相当', { exact: true }).check();
  await buildability(page).getByLabel('相当', { exact: true }).check();
  expect((await exportResult(page)).ratings[0].elapsedMs).toBe(600);
});

test('standalone file opens offline and safely renders untrusted text without revealing identifiers', async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), 'beadify-review-'));
  const text = '</script><script>window.reviewInjection = true</script><img src="https://invalid.example/track">';
  const html = renderReviewPage({ ...pack, title: text, cases: [{ ...pack.cases[0], prompt: text }] });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await context.setOffline(true);
  try {
    const path = join(directory, 'review.html');
    await writeFile(path, html);
    await page.goto(pathToFileURL(path).href);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(text);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(text);
    expect(await page.evaluate(() => (window as any).reviewInjection)).toBeUndefined();
    const visible = await page.locator('body').innerText();
    for (const value of ['legacy-v1', 'beadify-v2', pack.cases[0].configHash, pack.cases[0].left.hash]) expect(visible).not.toContain(value);
    await expect(page.getByAltText('左侧候选图')).toBeVisible();
    expect(await page.getByAltText('左侧候选图').evaluate(img => getComputedStyle(img).imageRendering)).toBe('pixelated');
    await page.getByLabel(reviewerLabel).fill('offline-reviewer');
    await likeness(page).getByLabel('左图', { exact: true }).check();
    await buildability(page).getByLabel('右图', { exact: true }).check();
    await page.reload();
    await expect(page.getByLabel(reviewerLabel)).toHaveValue('offline-reviewer');
    const result = await exportResult(page);
    expect(result.ratings).toHaveLength(1);
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ['read', 'write'] as const) {
  test('blocked storage ' + failure + ' leaves review and partial export usable', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(mode => {
      if (mode === 'read') Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage denied', 'SecurityError'); } });
      else Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
    }, failure);
    await openReview(page);
    await expect(page.getByText('浏览器未允许保存进度；请在离开前导出已完成项。')).toBeVisible();
    await page.getByLabel(reviewerLabel).fill('reviewer-no-storage');
    await likeness(page).getByLabel('都不像', { exact: true }).check();
    await buildability(page).getByLabel('都不适合', { exact: true }).check();
    await page.getByRole('button', { name: '下一项' }).click();
    await page.getByRole('button', { name: '上一项' }).click();
    await expect(likeness(page).getByLabel('都不像', { exact: true })).toBeChecked();
    expect((await exportResult(page)).ratings).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}
