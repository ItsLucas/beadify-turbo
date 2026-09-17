import type { ReviewPack } from './review';

/** A standalone, network-free reviewer; the assignment key never enters this document. */
export function renderReviewPage(pack: ReviewPack): string {
  const json = JSON.stringify(pack).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const title = pack.title.replace(/[&<>"']/g, character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>${title} · 盲评</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f3ec;color:#252b29;font:16px/1.55 system-ui,sans-serif}main{max-width:1120px;margin:0 auto;padding:24px}h1{font-size:25px;margin:0 0 8px}h2{font-size:18px;margin:0}p{margin:8px 0}.muted{color:#59615d;font-size:14px}.notice{padding:12px 16px;border-left:4px solid #9b7327;background:#fff8e6;margin:16px 0}.identity{display:flex;align-items:center;gap:12px;flex-wrap:wrap}input[type=text],textarea{font:inherit;border:1px solid #929c94;border-radius:6px;padding:9px;background:white;color:inherit}input[type=text]{width:280px;max-width:100%}textarea{display:block;width:100%;min-height:70px;margin-top:6px}button{font:inherit;padding:10px 16px;border:1px solid #52635a;border-radius:6px;background:white;color:inherit;cursor:pointer}button:disabled{opacity:.45;cursor:default}button.primary{background:#284e3e;color:white}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #dc8c23;outline-offset:3px}header{margin-bottom:18px}#progress{font-weight:600}.case-head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.source{margin:14px 0 20px;display:grid;justify-items:center;gap:8px;background:white;border:1px solid #d1d7cf;border-radius:8px;padding:14px}.source img{width:480px;max-width:100%;height:280px;object-fit:contain;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 / 12px 12px}.candidates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.candidate{margin:0;background:white;border:1px solid #d1d7cf;border-radius:8px;overflow:hidden}.candidate figcaption{font-weight:700;padding:10px 14px;border-bottom:1px solid #d1d7cf}.image-area{padding:14px;min-height:140px;overflow:auto;text-align:center}.pattern{display:inline-block;position:relative;vertical-align:top;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 / 12px 12px}.pattern img{display:block;image-rendering:pixelated}.pattern:after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(to right,#20202018 1px,transparent 1px),linear-gradient(to bottom,#20202018 1px,transparent 1px);background-size:var(--cell) var(--cell)}fieldset{border:1px solid #d1d7cf;border-radius:8px;background:white;padding:12px 16px;margin:18px 0}legend{font-weight:650;padding:0 6px}.choices{display:flex;flex-wrap:wrap;gap:10px 24px}.choices label{display:flex;align-items:center;gap:7px;cursor:pointer;padding:4px 0}.choices input{width:18px;height:18px;accent-color:#284e3e}footer{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin:20px 0}.nav{display:flex;gap:10px}#export-status{min-height:24px;color:#7a3f0b}@media(max-width:640px){main{padding:16px}.candidates{gap:8px}.image-area{padding:8px}h1{font-size:22px}.choices{gap:10px 18px}}
</style></head><body><main>
<header><h1>${title}</h1><p class="muted">离线盲评对比 · 所有图片已包含在本文件中</p>
<p class="notice">此包仅供开发验证，不构成泛化效果结论。原图组数按原始图片计数，同图的不同尺寸或颜色配置仍属于同一组。</p>
<div class="identity"><label for="evaluator">评审者代号（必填，请勿填写真实姓名）</label><input id="evaluator" type="text" maxlength="120" autocomplete="off" placeholder="例如：reviewer-07" required></div>
<p id="identity-status" class="muted" role="status"></p>
<button id="new-review" type="button">开始新评审（清空代号和全部作答）</button>
<div id="reset-confirmation" class="notice" hidden><p id="reset-warning"></p><button id="confirm-reset" type="button">确认清空并开始新评审</button> <button id="cancel-reset" type="button">保留当前评审</button></div>
<p id="storage-status" class="muted" role="status"></p></header>
<p id="progress" aria-live="polite"></p>
<section id="case"><div class="case-head"><h2 id="prompt"></h2><span id="dimensions" class="muted"></span></div>
<figure class="source"><figcaption>原图</figcaption><img id="source-image" alt="原图"></figure>
<div class="candidates"><figure class="candidate"><figcaption>左图</figcaption><div class="image-area"><span class="pattern"><img id="left-image" alt="左侧候选图"></span></div></figure><figure class="candidate"><figcaption>右图</figcaption><div class="image-area"><span class="pattern"><img id="right-image" alt="右侧候选图"></span></div></figure></div>
<fieldset><legend>1. 哪张图更像原图？</legend><div class="choices">
<label><input type="radio" name="likeness" value="left">左图</label><label><input type="radio" name="likeness" value="right">右图</label><label><input type="radio" name="likeness" value="tie">相当</label><label><input type="radio" name="likeness" value="neither">都不像</label>
</div></fieldset>
<fieldset><legend>2. 哪张图更适合实际拼豆？</legend><p class="muted">考虑轮廓清晰度、碎点、颜色分区及手工拼制难度。</p><div class="choices">
<label><input type="radio" name="buildability" value="left">左图</label><label><input type="radio" name="buildability" value="right">右图</label><label><input type="radio" name="buildability" value="tie">相当</label><label><input type="radio" name="buildability" value="neither">都不适合</label>
</div></fieldset>
<label for="note">失败原因或其他观察（选填）</label><textarea id="note" maxlength="4000" placeholder="例如：眼睛轮廓消失、出现零散杂色"></textarea></section>
<footer><div class="nav"><button id="previous" type="button">上一项</button><button id="next" type="button">下一项</button></div><button id="export" type="button" class="primary">导出已完成项 JSON</button></footer>
<p class="muted">两题都作答才计入导出；可先导出部分结果。切换项目会保留选择。计时仅累计页面可见期间，导出不包含未完成项。</p><p id="export-status" role="status"></p>
</main><script id="review-pack" type="application/json">${json}</script>
<script>
(function () {
  'use strict';
  const pack = JSON.parse(document.getElementById('review-pack').textContent);
  const key = 'beadify-review:' + pack.id;
  const choices = new Set(['left', 'right', 'tie', 'neither']);
  const emptyDraft = () => ({ likeness: null, buildability: null, elapsedMs: 0, note: '' });
  const drafts = new Map(pack.cases.map(item => [item.id, emptyDraft()]));
  const evaluator = document.getElementById('evaluator');
  const note = document.getElementById('note');
  const exportButton = document.getElementById('export');
  const storageStatus = document.getElementById('storage-status');
  let index = 0;
  let activeSince = null;
  let storageAvailable = true;
  let evaluatorId = '';
  let identityLocked = false;
  function storageFailure() {
    storageAvailable = false;
    storageStatus.textContent = '浏览器未允许保存进度；请在离开前导出已完成项。';
  }
  try {
    const raw = localStorage.getItem(key);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && saved.schemaVersion === 1 && saved.packId === pack.id && Array.isArray(saved.drafts)) {
      evaluatorId = typeof saved.evaluatorId === 'string' ? saved.evaluatorId.slice(0, 120).trim() : '';
      evaluator.value = evaluatorId;
      if (Number.isInteger(saved.index) && saved.index >= 0 && saved.index < pack.cases.length) index = saved.index;
      for (const value of saved.drafts) {
        if (!evaluatorId || !value || !drafts.has(value.caseId)) continue;
        const draft = drafts.get(value.caseId);
        draft.likeness = choices.has(value.likeness) ? value.likeness : null;
        draft.buildability = choices.has(value.buildability) ? value.buildability : null;
        draft.elapsedMs = Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0;
        draft.note = typeof value.note === 'string' ? value.note.slice(0, 4000) : '';
      }
      identityLocked = !!evaluatorId && (saved.identityLocked === true || [...drafts.values()].some(draft => draft.likeness || draft.buildability || draft.note));
    }
  } catch (_) { storageFailure(); }
  function current() { return pack.cases[index] ? drafts.get(pack.cases[index].id) : null; }
  function checkpoint() {
    const now = performance.now();
    if (activeSince !== null && current()) current().elapsedMs += Math.max(0, now - activeSince);
    activeSince = document.visibilityState === 'visible' && current() ? now : null;
  }
  function completed() {
    return pack.cases.filter(item => {
      const draft = drafts.get(item.id);
      return choices.has(draft.likeness) && choices.has(draft.buildability);
    });
  }
  function persist() {
    checkpoint();
    if (!storageAvailable) return;
    try {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, packId: pack.id, evaluatorId, identityLocked, index,
        drafts: pack.cases.map(item => Object.assign({ caseId: item.id }, drafts.get(item.id))) }));
      storageStatus.textContent = '进度已保存在当前浏览器；请导出 JSON 备份或交回评审。';
    } catch (_) { storageFailure(); }
  }
  function updateProgress() {
    const count = completed().length;
    const groups = new Set(pack.cases.map(item => item.groupId)).size;
    document.getElementById('progress').textContent = '第 ' + (pack.cases.length ? index + 1 : 0) + ' / ' + pack.cases.length + ' 项 · 已完成 ' + count + ' / ' + pack.cases.length + ' 项 · 原图组数 ' + groups;
    exportButton.disabled = !evaluatorId || count === 0;
    evaluator.readOnly = identityLocked;
    if (identityLocked) evaluator.value = evaluatorId;
    document.querySelectorAll('fieldset').forEach(field => { field.disabled = !evaluatorId; });
    note.disabled = !evaluatorId;
    document.getElementById('identity-status').textContent = identityLocked
      ? '当前作答属于“' + evaluatorId + '”；更换评审者请使用“开始新评审”。'
      : '请先填写评审者代号；首次作答后代号将锁定。';
  }
  function resizeImages() {
    const item = pack.cases[index];
    if (!item) return;
    const images = ['left-image', 'right-image'].map(id => document.getElementById(id));
    const available = Math.min(...images.map(img => img.parentElement.parentElement.clientWidth - (innerWidth <= 640 ? 16 : 28)));
    const scale = Math.max(1, Math.floor(Math.min(available / item.width, 450 / item.height)));
    images.forEach(img => {
      img.style.width = item.width * scale + 'px';
      img.style.height = item.height * scale + 'px';
      img.parentElement.style.setProperty('--cell', scale + 'px');
    });
  }
  function render() {
    const item = pack.cases[index];
    const draft = current();
    document.getElementById('case').hidden = !item;
    if (item) {
      document.getElementById('prompt').textContent = item.prompt;
      document.getElementById('dimensions').textContent = item.width + ' × ' + item.height + ' 格 · 最多 ' + item.maxColors + ' 色';
      document.getElementById('source-image').src = item.sourceImage;
      document.getElementById('left-image').src = item.left.image;
      document.getElementById('right-image').src = item.right.image;
      document.querySelectorAll('input[type=radio]').forEach(input => { input.checked = draft[input.name] === input.value; });
      note.value = draft.note;
      resizeImages();
    }
    document.getElementById('previous').disabled = index === 0;
    document.getElementById('next').disabled = index >= pack.cases.length - 1;
    updateProgress();
  }
  document.querySelectorAll('input[type=radio]').forEach(input => input.addEventListener('change', () => {
    if (!evaluatorId) { render(); return; }
    identityLocked = true;
    current()[input.name] = input.value;
    persist(); updateProgress();
  }));
  evaluator.addEventListener('input', () => {
    if (!identityLocked) evaluatorId = evaluator.value.trim();
    persist(); updateProgress();
  });
  note.addEventListener('input', () => {
    if (current() && evaluatorId) { identityLocked = true; current().note = note.value; }
    persist(); updateProgress();
  });
  document.getElementById('new-review').addEventListener('click', () => {
    document.getElementById('reset-warning').textContent = '将清空当前 ' + completed().length + ' 项完整作答、全部草稿和计时。未导出的结果会丢失，请先导出需要保留的作答。';
    document.getElementById('reset-confirmation').hidden = false;
  });
  document.getElementById('cancel-reset').addEventListener('click', () => { document.getElementById('reset-confirmation').hidden = true; });
  document.getElementById('confirm-reset').addEventListener('click', () => {
    pack.cases.forEach(item => drafts.set(item.id, emptyDraft()));
    evaluatorId = ''; evaluator.value = ''; identityLocked = false;
    index = 0; activeSince = null;
    document.getElementById('reset-confirmation').hidden = true;
    document.getElementById('export-status').textContent = '';
    render(); persist(); evaluator.focus();
  });
  function navigate(delta) {
    persist();
    index = Math.max(0, Math.min(pack.cases.length - 1, index + delta));
    activeSince = null;
    render(); persist();
    document.getElementById('export-status').textContent = '';
  }
  document.getElementById('previous').addEventListener('click', () => navigate(-1));
  document.getElementById('next').addEventListener('click', () => navigate(1));
  exportButton.addEventListener('click', () => {
    persist();
    if (!evaluatorId || !completed().length) return;
    const result = { schemaVersion: 1, packId: pack.id, evaluatorId, ratings: completed().map(item => {
      const draft = drafts.get(item.id);
      return { caseId: item.id, likeness: draft.likeness, buildability: draft.buildability, elapsedMs: Math.round(draft.elapsedMs), note: draft.note };
    }) };
    const blob = new Blob([JSON.stringify(result, null, 2) + '\\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'review-' + pack.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) + '.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('export-status').textContent = '已导出 ' + result.ratings.length + ' / ' + pack.cases.length + ' 项；未完成项的选择仍保留在当前页面。';
  });
  document.addEventListener('visibilitychange', persist);
  window.addEventListener('pagehide', persist);
  window.addEventListener('resize', resizeImages);
  render(); persist();
})();
</script></body></html>`;
}
