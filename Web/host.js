// SPDX-License-Identifier: GPL-3.0-or-later
// iPadのアプリ（Swift）との受け渡し。URLをブラウザで開いたとき（Web版）は、
// 同じ形の受け手をこのファイルの中で用意する：保存はIndexedDB、読み上げはspeechSynthesis。
(function (root) {
  'use strict';
  const listeners = new Set();
  const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.sawaru;
  let bootResolve;
  const booted = new Promise(r => { bootResolve = r; });

  // Swiftからの呼び出し口。
  root.SawaruNative = {
    bootstrap(event) { bootResolve(event); return booted.then(() => true); },
    onEvent(event) { listeners.forEach(fn => { try { fn(event); } catch (e) { console.error(e); } }); }
  };
  const emit = event => root.SawaruNative.onEvent(event);

  let post;
  if (handler) {
    post = message => handler.postMessage(message);
  } else {
    // ---- Web版（SafariなどのブラウザでURLを開いたとき） ----
    // 保存はIndexedDB（写真が入っても収まるように）。使えないときだけlocalStorage。
    // 読み込みに失敗したときは「まだ何も無い」と見なさず止める（最初のセットで上書きしないため）。
    const DB = 'erabu-sawaru', STORE = 'docs', KEY = 'snapshot', LS_KEY = 'erabu-sawaru-web-v1';
    let dbPromise = null;
    const openDb = () => {
      if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
        if (!root.indexedDB) { reject(new Error('no indexedDB')); return; }
        const rq = root.indexedDB.open(DB, 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
        rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error);
      }).catch(e => { dbPromise = null; throw e; });
      return dbPromise;
    };
    async function load() {
      let dbOk = true;
      try {
        const db = await openDb();
        const v = await new Promise((resolve, reject) => { const rq = db.transaction(STORE).objectStore(STORE).get(KEY); rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
        if (v) return {type: 'bootstrap', snapshot: v};
      } catch (e) { console.error(e); dbOk = false; }
      try { const s = root.localStorage.getItem(LS_KEY); if (s) return {type: 'bootstrap', snapshot: JSON.parse(s)}; }
      catch (e) { console.error(e); return {type: 'bootstrap', loadError: true}; }
      if (!dbOk && root.indexedDB) return {type: 'bootstrap', loadError: true};
      return {type: 'bootstrap', snapshot: {version: 1, sets: [], prefs: {}}};
    }
    async function save(snapshot) {
      try {
        const db = await openDb();
        await new Promise((resolve, reject) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(snapshot, KEY); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
        try { root.localStorage.removeItem(LS_KEY); } catch {}
      } catch { root.localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); }
    }

    // 読み上げ：Safariは、触れた操作の中ですぐに話し始めないと音が出ないことがあるので、待たずに呼ぶ。
    let speaking = 0;
    function speak(text, rate) {
      const synth = root.speechSynthesis;
      if (!synth || !root.SpeechSynthesisUtterance) { emit({type: 'speech', state: 'error', message: 'このブラウザでは読み上げを使えません。'}); return; }
      synth.cancel();
      const u = new root.SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP';
      const v = synth.getVoices().find(x => /^ja(-|_|$)/i.test(x.lang)); if (v) u.voice = v;
      u.rate = Math.max(0.5, Math.min(1.3, Number(rate) || 0.9));
      const mine = ++speaking;
      u.onend = () => { if (mine === speaking) emit({type: 'speech', state: 'ended'}); };
      synth.speak(u);
    }
    function stopSpeech() { speaking++; if (root.speechSynthesis) root.speechSynthesis.cancel(); }

    // 画面を暗くしない（Screen Wake Lock。使えないブラウザでは何もしない）。
    let wantAwake = false, lock = null;
    async function applyAwake() {
      if (!wantAwake || document.hidden) { if (lock) { try { await lock.release(); } catch {} lock = null; } return; }
      if (lock || !navigator.wakeLock) return;
      try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch { /* 次に触れたときにもう一度 */ }
    }
    document.addEventListener('pointerdown', () => { if (wantAwake && !lock) applyAwake(); }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { stopSpeech(); emit({type: 'background'}); } else { emit({type: 'foreground'}); }
      applyAwake();
    });

    post = message => {
      switch (message.type) {
        case 'ready':
          try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
          load().then(bootResolve);
          break;
        case 'save':
          save(message.snapshot).then(() => emit({type: 'saved', revision: message.revision}), () => emit({type: 'saveError', revision: message.revision}));
          break;
        case 'speak': speak(message.text, message.rate); break;
        case 'stopSpeech': stopSpeech(); break;
        case 'keepAwake': wantAwake = !!message.on; applyAwake(); break;
        case 'reload': root.location.reload(); break;
        case 'export': {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([message.text], {type: 'application/json'}));
          a.download = (String(message.name || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 60) || 'えらぶの窓') + '.erabu.json';
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          break;
        }
        default: break;
      }
    };
  }

  root.SawaruHost = {
    native: !!handler,
    send(type, data = {}) { post({type, ...data}); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() { post({type: 'ready'}); return booted; }
  };
})(window);
