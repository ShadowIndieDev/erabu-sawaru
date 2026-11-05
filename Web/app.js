// SPDX-License-Identifier: GPL-3.0-or-later
// えらぶの窓 さわる2択：画面。
(function () {
  'use strict';
  const L = window.SawaruLogic, host = window.SawaruHost;
  const $ = id => document.getElementById(id);
  const HOLD_MS = 1000; // 設定を開く長押しの長さ
  const REPEAT_GAP_MS = 1200; // 「もう一度読む」の連続を抑える間隔

  let keptRaw = [], sets = [], prefs = L.sanitizePrefs({}), session = null, paused = false;
  let assetUrls = {}, revision = 0, lastRepeatAt = 0, noticeTimer = null;
  const pendingSaves = new Map();

  // ---------- 見本の絵：アトラスを8枚に切り分ける（ネットワークは使わない） ----------
  async function prepareAssets() {
    const data = window.SAWARU_ATLAS.split(',')[1] || '';
    const bin = atob(data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const atlasUrl = URL.createObjectURL(new Blob([bytes], {type: 'image/png'}));
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('見本の絵を読めませんでした')); im.src = atlasUrl; });
    const cw = img.naturalWidth / 4, ch = img.naturalHeight / 2, size = Math.round(Math.min(cw, ch));
    for (const a of L.ASSETS) {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, size, size);
      g.drawImage(img, a.col * cw + (cw - size) / 2, a.row * ch + (ch - size) / 2, size, size, 0, 0, size, size);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      assetUrls[a.id] = URL.createObjectURL(blob);
    }
    URL.revokeObjectURL(atlasUrl);
  }
  function paint(el, image) {
    const url = image.kind === 'builtin' ? assetUrls[image.id] : image.data;
    el.style.backgroundImage = url ? `url("${url}")` : '';
  }

  // ---------- 知らせ・保存・音声 ----------
  function notice(text) {
    const el = $('notice'); el.textContent = text; el.classList.add('show');
    clearTimeout(noticeTimer); noticeTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function snapshot() { return {version: 1, sets: [...sets, ...keptRaw], prefs: {...prefs, setId: session?.set.id, questionId: session?.question.id}}; }
  function persist() {
    const snap = snapshot();
    const size = JSON.stringify(snap).length;
    if (size > 58 * 1024 * 1024) return Promise.reject(new Error('保存の容量（60MB）を超えます。写真を減らすか、使わないセットを書き出して削除してください。'));
    const rev = ++revision;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingSaves.delete(rev); reject(new Error('保存の確認ができませんでした。')); }, 10000);
      pendingSaves.set(rev, {resolve, reject, timer});
      host.send('save', {snapshot: snap, revision: rev});
    });
  }
  const persistQuietly = () => persist().catch(e => notice(e.message));
  function speak(text) { if (text) host.send('speak', {text, rate: prefs.rate}); }
  function stopSpeech() { host.send('stopSpeech'); }
  const spokenText = option => option.speech || option.label;

  host.on(event => {
    if (event.type === 'saved' || event.type === 'saveError') {
      const p = pendingSaves.get(event.revision); if (!p) return;
      pendingSaves.delete(event.revision); clearTimeout(p.timer);
      if (event.type === 'saved') p.resolve(); else p.reject(new Error('保存できませんでした。iPadの空き容量を確認してください。'));
    } else if (event.type === 'speech' && event.state === 'error') {
      notice(event.message || '読み上げできませんでした。');
    } else if (event.type === 'exportError') {
      notice('書き出しできませんでした。');
    } else if (event.type === 'background') {
      cancelHold();
    } else if (event.type === 'foreground') {
      host.send('keepAwake', {on: prefs.keepAwake});
    }
  });

  // ---------- 遊ぶ画面 ----------
  const halves = {left: $('half-left'), right: $('half-right')};
  function render() {
    const q = session.question;
    $('question').textContent = q.question;
    $('set-name').textContent = session.set.name;
    $('question-count').textContent = `質問 ${session.index + 1} / ${session.count}`;
    for (const side of ['left', 'right']) {
      const el = halves[side], opt = session.optionAt(side);
      paint(el.querySelector('.picture'), opt.image);
      el.querySelector('.label').textContent = opt.label;
      el.classList.toggle('chosen', session.chosenSide === side);
      el.classList.toggle('faded', !!session.selected && session.chosenSide !== side);
    }
    $('app').classList.toggle('no-labels', !prefs.labels);
    const dz = $('app').querySelector('.dead-zone'), ratio = L.DEAD_ZONES[prefs.deadZone] || 0;
    dz.style.flexBasis = (ratio * 100) + '%'; dz.classList.toggle('wide', ratio > 0);
    $('redo').disabled = !session.selected;
    $('prev').disabled = session.index === 0;
    $('next').disabled = session.index >= session.count - 1;
    $('pause').textContent = paused ? '再開する' : '休む';
    $('pause').setAttribute('aria-pressed', String(paused));
    $('paused-cover').hidden = !paused;
  }
  const sheetOpen = () => !$('sheet-settings').hidden || !$('sheet-editor').hidden;

  function ripple(x, y) {
    const r = document.createElement('div'); r.className = 'ripple'; r.style.left = x + 'px'; r.style.top = y + 'px';
    $('ripple-layer').append(r); setTimeout(() => r.remove(), 700);
  }
  // 触れた瞬間に選ぶ。決めるのは、最初に触れた指（isPrimary）の位置だけ。
  function onStageDown(e) {
    if (!e.isPrimary || paused || sheetOpen() || !session) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const box = document.querySelector('.halves').getBoundingClientRect();
    if (session.selected) {
      if (prefs.afterTouch === 'repeat' && e.timeStamp - lastRepeatAt > REPEAT_GAP_MS) {
        lastRepeatAt = e.timeStamp; ripple(e.clientX, e.clientY); speak(spokenText(session.chosen));
      }
      return;
    }
    const side = L.sideAt(e.clientX - box.left, box.width, prefs.deadZone);
    if (!side) return;
    const option = session.choose(side);
    if (!option) return;
    lastRepeatAt = e.timeStamp;
    ripple(e.clientX, e.clientY);
    render();
    speak(spokenText(option));
  }
  const stage = $('stage');
  stage.addEventListener('pointerdown', onStageDown);
  // 拡大・ページ送り・長押しのメニュー・ダブルタップでの拡大を起こさない。
  stage.addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); }, {passive: false});
  document.addEventListener('touchmove', e => { if (!e.target.closest('.sheet-body') && e.cancelable) e.preventDefault(); }, {passive: false});
  for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) document.addEventListener(type, e => e.preventDefault(), {passive: false});
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('selectstart', e => { if (!e.target.closest?.('.sheet')) e.preventDefault(); });

  // ---------- 上の帯（支援者） ----------
  $('redo').addEventListener('click', () => { if (!session.selected) return; session.reset(); stopSpeech(); render(); notice('えらびなおせます'); });
  $('repeat').addEventListener('click', () => { speak(session.selected ? spokenText(session.chosen) : session.question.question); });
  $('pause').addEventListener('click', () => { paused = !paused; stopSpeech(); render(); notice(paused ? 'おやすみ中です' : '再開しました'); });
  $('prev').addEventListener('click', () => changeQuestion(-1));
  $('next').addEventListener('click', () => changeQuestion(1));
  $('swap').addEventListener('click', () => { session.swap(); stopSpeech(); render(); notice('左右を入れ替えました'); });
  function changeQuestion(step) { if (!session.go(step)) return; stopSpeech(); render(); persistQuietly(); }

  let holdTimer = null;
  const holdButton = $('settings-hold');
  holdButton.style.setProperty('--hold-ms', HOLD_MS + 'ms');
  function cancelHold() { clearTimeout(holdTimer); holdTimer = null; holdButton.classList.remove('holding'); }
  holdButton.addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    cancelHold(); void holdButton.offsetWidth; holdButton.classList.add('holding');
    holdTimer = setTimeout(() => { cancelHold(); openSettings(); }, HOLD_MS);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) holdButton.addEventListener(type, cancelHold);
  holdButton.addEventListener('click', () => { if (!$('sheet-settings').hidden) return; notice('設定は、ボタンを長押しすると開きます'); });

  // ---------- 設定 ----------
  function fillSetSelects() {
    const s = $('set-select'); s.replaceChildren(...sets.map(x => new Option(x.name, x.id))); s.value = session.set.id;
    const q = $('question-select'); q.replaceChildren(...session.set.questions.map((x, i) => new Option(`${i + 1}. ${x.question}`, x.id))); q.value = session.question.id;
  }
  function openSettings() {
    stopSpeech(); fillSetSelects();
    $('pref-dead').value = prefs.deadZone; $('pref-after').value = prefs.afterTouch;
    $('pref-labels').checked = prefs.labels; $('pref-awake').checked = prefs.keepAwake;
    $('pref-rate').value = String(prefs.rate); $('rate-value').textContent = prefs.rate.toFixed(1) + '倍';
    $('import-status').textContent = '';
    $('version-text').textContent = '版 ' + window.SAWARU_VERSION;
    $('sheet-settings').hidden = false;
  }
  $('close-settings').addEventListener('click', () => { $('sheet-settings').hidden = true; render(); persistQuietly(); });
  $('set-select').addEventListener('change', e => { const set = sets.find(x => x.id === e.target.value); if (!set) return; session.load(set); paused = false; fillSetSelects(); render(); });
  $('question-select').addEventListener('change', e => { session.load(session.set, e.target.value); render(); });
  $('pref-dead').addEventListener('change', e => { prefs.deadZone = e.target.value; render(); });
  $('pref-after').addEventListener('change', e => { prefs.afterTouch = e.target.value; });
  $('pref-labels').addEventListener('change', e => { prefs.labels = e.target.checked; render(); });
  $('pref-awake').addEventListener('change', e => { prefs.keepAwake = e.target.checked; host.send('keepAwake', {on: prefs.keepAwake}); });
  $('pref-rate').addEventListener('input', e => { prefs.rate = L.sanitizePrefs({rate: e.target.value}).rate; $('rate-value').textContent = prefs.rate.toFixed(1) + '倍'; });
  $('test-voice').addEventListener('click', () => speak('こんにちは。'));
  $('stop-voice').addEventListener('click', stopSpeech);
  $('import-file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    const status = $('import-status'), before = sets.slice();
    try {
      if (file.size > L.LIMITS.fileBytes) throw new Error('セットのファイルは50MB以下にしてください。');
      const result = L.importSets(await file.text());
      if (!result.sets.length) throw new Error('2択の質問がないため、追加できるセットがありませんでした。');
      if (sets.length + result.sets.length > L.LIMITS.sets) throw new Error(`セットは${L.LIMITS.sets}個までです。使わないセットを削除してから読み込んでください。`);
      sets.push(...result.sets);
      await persist();
      fillSetSelects();
      const count = result.sets.reduce((n, s) => n + s.questions.length, 0);
      let text = `${result.sets.length}セット（質問 ${count}）を追加しました。「使うセット」から選べます。`;
      if (result.skippedQuestions) text += ` 3択・4択の質問 ${result.skippedQuestions} は読み飛ばしました。`;
      status.textContent = text;
    } catch (err) { sets = before; status.textContent = err.message; }
  });
  $('edit-set').addEventListener('click', () => openEditor(session.set, false));
  $('new-set').addEventListener('click', () => {
    if (sets.length >= L.LIMITS.sets) { $('import-status').textContent = `セットは${L.LIMITS.sets}個までです。`; return; }
    openEditor({id: L.makeId(), name: '新しいセット', questions: [blankQuestion()]}, true);
  });

  // ---------- 編集 ----------
  let draft = null, draftIndex = 0, draftIsNew = false, draftDirty = false;
  function blankQuestion() {
    return {id: L.makeId(), question: 'どちらが いい？', options: [
      {id: L.makeId(), label: 'りんご', speech: '', image: {kind: 'builtin', id: 'apple'}},
      {id: L.makeId(), label: 'バナナ', speech: '', image: {kind: 'builtin', id: 'banana'}}]};
  }
  const optionEditors = [...document.querySelectorAll('.option-editor')];
  optionEditors.forEach((box, index) => {
    box.append($('option-template').content.cloneNode(true));
    const grid = box.querySelector('.builtin-grid');
    for (const a of L.ASSETS) {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.id = a.id; b.setAttribute('aria-label', a.label);
      b.addEventListener('click', () => {
        const opt = draft.questions[draftIndex].options[index], old = L.ASSETS.find(x => opt.image.kind === 'builtin' && x.id === opt.image.id);
        // 言葉が見本の名前のままなら、絵に合わせて言葉も変える。
        if (!opt.label.trim() || (old && opt.label === old.label)) opt.label = a.label;
        opt.image = {kind: 'builtin', id: a.id}; draftDirty = true; renderEditor();
      });
      grid.append(b);
    }
    box.querySelector('.opt-label').addEventListener('input', e => { draft.questions[draftIndex].options[index].label = e.target.value; draftDirty = true; renderTabs(); });
    box.querySelector('.opt-speech').addEventListener('input', e => { draft.questions[draftIndex].options[index].speech = e.target.value; draftDirty = true; });
    box.querySelector('.opt-photo').addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0]; e.target.value = '';
      if (!file) return;
      try {
        const data = await shrinkPhoto(file);
        draft.questions[draftIndex].options[index].image = {kind: 'photo', data}; draftDirty = true; $('editor-error').textContent = ''; renderEditor();
      } catch (err) { $('editor-error').textContent = err.message; }
    });
  });
  async function shrinkPhoto(file) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('写真はJPG・PNG・WebPを選んでください。');
    if (file.size > 15 * 1024 * 1024) throw new Error('写真は1枚15MBまでです。');
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('写真を読み取れませんでした。')); im.src = url; });
      for (const [edge, quality] of [[1024, .85], [800, .78], [640, .7]]) {
        const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', quality);
        if (data.length <= L.LIMITS.photoChars) return data;
      }
      throw new Error('写真が大きすぎます。別の写真を選んでください。');
    } finally { URL.revokeObjectURL(url); }
  }
  function openEditor(set, isNew) {
    draft = JSON.parse(JSON.stringify(set)); draftIsNew = isNew; draftDirty = isNew;
    draftIndex = isNew ? 0 : Math.max(0, draft.questions.findIndex(q => q.id === session.question.id));
    $('editor-title').textContent = isNew ? '新しいセット' : 'セットを編集';
    $('delete-set').hidden = isNew;
    $('editor-error').textContent = '';
    $('edit-name').value = draft.name;
    $('sheet-editor').hidden = false;
    renderEditor();
  }
  function renderTabs() {
    const tabs = $('question-tabs');
    tabs.replaceChildren(...draft.questions.map((q, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = `${i + 1}. ${q.question || '（問いかけなし）'}`;
      b.classList.toggle('current', i === draftIndex);
      b.addEventListener('click', () => { draftIndex = i; renderEditor(); });
      return b;
    }));
  }
  function renderEditor() {
    const q = draft.questions[draftIndex];
    renderTabs();
    $('edit-question').value = q.question;
    optionEditors.forEach((box, i) => {
      const o = q.options[i];
      box.querySelector('.opt-label').value = o.label;
      box.querySelector('.opt-speech').value = o.speech || '';
      paint(box.querySelector('.opt-preview .picture'), o.image);
      box.querySelectorAll('.builtin-grid button').forEach(b => {
        b.style.backgroundImage = `url("${assetUrls[b.dataset.id]}")`;
        b.classList.toggle('current', o.image.kind === 'builtin' && o.image.id === b.dataset.id);
      });
    });
    $('add-question').disabled = draft.questions.length >= L.LIMITS.questions;
    $('delete-question').disabled = draft.questions.length <= 1;
    $('move-up').disabled = draftIndex === 0;
    $('move-down').disabled = draftIndex >= draft.questions.length - 1;
  }
  $('edit-name').addEventListener('input', e => { draft.name = e.target.value; draftDirty = true; });
  $('edit-question').addEventListener('input', e => { draft.questions[draftIndex].question = e.target.value; draftDirty = true; renderTabs(); });
  $('add-question').addEventListener('click', () => { draft.questions.splice(draftIndex + 1, 0, blankQuestion()); draftIndex++; draftDirty = true; renderEditor(); });
  $('delete-question').addEventListener('click', () => {
    if (draft.questions.length <= 1 || !confirm(`質問${draftIndex + 1}を削除しますか？`)) return;
    draft.questions.splice(draftIndex, 1); draftIndex = Math.min(draftIndex, draft.questions.length - 1); draftDirty = true; renderEditor();
  });
  function move(step) {
    const to = draftIndex + step; if (to < 0 || to >= draft.questions.length) return;
    const [q] = draft.questions.splice(draftIndex, 1); draft.questions.splice(to, 0, q); draftIndex = to; draftDirty = true; renderEditor();
  }
  $('move-up').addEventListener('click', () => move(-1));
  $('move-down').addEventListener('click', () => move(1));
  function validDraft() {
    try { return L.normalizeSet(draft); }
    catch (e) {
      if (Number.isInteger(e.questionIndex)) { draftIndex = e.questionIndex; renderEditor(); }
      $('editor-error').textContent = e.message; return null;
    }
  }
  $('save-edit').addEventListener('click', async () => {
    const set = validDraft(); if (!set) return;
    const before = sets.slice(), at = sets.findIndex(s => s.id === set.id);
    if (at < 0) sets.push(set); else sets[at] = set;
    const questionId = set.questions[draftIndex]?.id;
    const previous = session.set, previousQ = session.question.id;
    session.load(set, questionId);
    $('save-edit').disabled = true;
    try {
      await persist();
      $('sheet-editor').hidden = true; fillSetSelects(); render(); notice('保存しました');
    } catch (e) {
      sets = before; session.load(sets.includes(previous) ? previous : sets[0], previousQ);
      $('editor-error').textContent = e.message;
    } finally { $('save-edit').disabled = false; }
  });
  $('cancel-edit').addEventListener('click', () => {
    if (draftDirty && !confirm('変更を保存せずに閉じますか？')) return;
    $('sheet-editor').hidden = true;
  });
  $('export-set').addEventListener('click', () => {
    const set = validDraft(); if (!set) return;
    try { host.send('export', {text: L.exportSet(set), name: set.name}); }
    catch (e) { $('editor-error').textContent = e.message; }
  });
  $('delete-set').addEventListener('click', async () => {
    if (sets.length <= 1) { $('editor-error').textContent = 'セットは1つ以上必要です。新しいセットを作ってから削除してください。'; return; }
    if (!confirm(`セット「${draft.name}」を削除しますか？ 書き出していない写真や言葉は戻せません。`)) return;
    const before = sets.slice(), previous = session.set;
    sets = sets.filter(s => s.id !== draft.id);
    if (session.set.id === draft.id) session.load(sets[0]);
    try { await persist(); $('sheet-editor').hidden = true; fillSetSelects(); render(); notice('セットを削除しました'); }
    catch (e) { sets = before; session.load(previous); $('editor-error').textContent = e.message; }
  });

  // ---------- 起動 ----------
  function stopStartup(text, retry) {
    $('startup').hidden = false; $('startup-text').textContent = text; $('startup-retry').hidden = !retry;
  }
  $('startup-retry').addEventListener('click', () => { if (host.native) host.send('reload'); else location.reload(); });
  async function boot() {
    document.body.classList.toggle('web', !host.native);
    const event = await host.start();
    if (event.loadError) {
      stopStartup('保存したセットを読み込めませんでした。\n上書きしないよう、ここで止めています。アプリは削除せず、読み込み直してください。', true);
      return;
    }
    try { await prepareAssets(); } catch (e) { stopStartup(e.message, true); return; }
    const snap = event.snapshot || {};
    prefs = L.sanitizePrefs(snap.prefs);
    const loaded = [];
    // 読めないセットは消さずに、そのまま残して保存し直す。
    for (const raw of Array.isArray(snap.sets) ? snap.sets : []) { try { loaded.push(L.normalizeSet(raw)); } catch (e) { console.error(e); keptRaw.push(raw); } }
    const fresh = !loaded.length;
    sets = fresh ? L.starterSets() : loaded;
    if (keptRaw.length) notice('読めないセットがありました。ほかのセットは使えます。');
    const set = sets.find(s => s.id === prefs.setId) || sets[0];
    session = new L.ChoiceSession(set, prefs.questionId);
    $('startup').hidden = true; $('app').hidden = false;
    render();
    host.send('keepAwake', {on: prefs.keepAwake});
    if (fresh) persistQuietly();
  }
  boot().catch(e => { console.error(e); stopStartup('起動できませんでした：' + e.message, true); });
})();
