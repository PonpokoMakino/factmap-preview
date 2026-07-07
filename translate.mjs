#!/usr/bin/env node
// ファクトマップ 見出し翻訳（北極星：海外ニュースを日本語で・原文は保持）v0.1
// 取り込んだ見出しのうち外国語(lang≠ja)を日本語へ忠実に訳す。評価語・ニュアンスは足さない。原文リンクは別途UIで保持。
// 使い方:  GEMINI_API_KEY=... node --env-file=.env translate.mjs [out-ingest.json]
//   → out-translations.json（{原文見出し: 日本語訳}）。home/detail がこれを使い「日本語訳（原文: …↗）」で表示する。

import { readFileSync, writeFileSync } from 'node:fs';

// モデルfallback：無料枠は「1日20回/モデル」＝モデル別勘定。既定はlite→枯渇時はflashへ切替（envで単一固定も可）
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
function need(n) { const v = process.env[n]; if (!v) { console.error(n + ' が未設定です。'); process.exit(1); } return v; }

async function translateBatch(texts, MODEL) {
  const key = need('GEMINI_API_KEY');
  const sys = 'あなたは中立で忠実な翻訳者。次の外国語の見出しを日本語へ訳す。' +
    '評価語・感情語・ニュアンス・含みを足さない（原文の意味だけを正確に）。' +
    '入力と同じ番号・同じ順で、訳文だけを1行ずつ返す。説明や原文は付けない。';
  const user = texts.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + key;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, maxOutputTokens: 2048 } }),
  });
  if (!res.ok) throw new Error('translate ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return out.split('\n').map(l => l.replace(/^\s*\d+[.)、]\s*/, '').trim()).filter(Boolean);
}

async function main() {
  const d = JSON.parse(readFileSync(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'out-ingest.json', 'utf8'));
  const en = [...new Set((d.headlines || []).filter(h => h.lang && h.lang !== 'ja' && h.title).map(h => h.title))];
  // 差分処理：前回の出力を読み、未翻訳の見出しだけAPIへ（無料枠が1日20回に縮小されたため必須）
  let old = {};
  try { old = JSON.parse(readFileSync('out-translations.json', 'utf8')).translations || {}; } catch (e) {}
  if (!en.length) {
    if (Object.keys(old).length) { console.error('翻訳対象なし→前回データ温存'); return; }
    writeFileSync('out-translations.json', JSON.stringify({ translations: {} }, null, 2)); console.error('翻訳対象（外国語の見出し）なし。'); return;
  }
  const pending = en.filter(t => !old[t]);
  let ja = [];
  if (pending.length) {
    for (let t = 0; t < 3; t++) {
      const model = MODELS[Math.min(Math.floor(t / 2), MODELS.length - 1)];   // 2回目まで主モデル・3回目は控えへ
      try { ja = await translateBatch(pending, model); if (t === 2 && MODELS.length > 1) console.error('  ↪ 控えモデル(' + model + ')で成功'); break; }
      catch (e) {
        if (t === 2) { console.error('  翻訳失敗（無料枠の混雑/枯渇？）: ' + e.message); break; }
        await new Promise(r => setTimeout(r, Math.min(500 * 2 ** t, 8000)));   // 指数バックオフ（429/503の無待機連打を防ぐ）
      }
    }
    // 件数が一致しない＝対応関係が保証できない（行の統合/省略/順序ずれ）。別見出しの訳が付く事故を防ぐため全体を破棄。
    if (ja.length !== pending.length) {
      if (ja.length) console.error('  翻訳の行数不一致（入力' + pending.length + '行/出力' + ja.length + '行）→ 取り違え防止のため全体を破棄。原文のまま表示されます。');
      ja = [];
    }
  } else {
    console.error('  新規の外国語見出しなし＝API呼び出しゼロ（差分処理）');
  }
  const translations = {};
  en.forEach(t => { if (old[t]) translations[t] = old[t]; });   // 翻訳済みは再利用（現行見出し分のみ＝無限肥大防止）
  pending.forEach((t, i) => { if (ja[i]) translations[t] = ja[i]; });
  // 枯渇/失敗で0件になった時、既にある良いデータを空で上書きしない（前回データを温存）
  if (!Object.keys(translations).length) {
    try { const o = JSON.parse(readFileSync('out-translations.json','utf8')); if (Object.keys(o.translations||{}).length) { console.error('  0件→前回の翻訳を温存'); return; } } catch(e){}
  }
  writeFileSync('out-translations.json', JSON.stringify({ translations }, null, 2));
  console.error('翻訳 ' + Object.keys(translations).length + '/' + en.length + ' 件（新規' + pending.length + '・再利用' + en.filter(t => old[t]).length + '） → out-translations.json');
  Object.entries(translations).slice(0, 4).forEach(([k, v]) => console.error('  ' + k.slice(0, 34) + ' → ' + v));
}

main().catch(e => { console.error(e); process.exit(1); });
