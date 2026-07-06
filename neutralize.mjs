#!/usr/bin/env node
// ファクトマップ 中立見出し（ブラインド見出し）v0.1
// 設計図「段階3：受け手の中立化」＝見出しを無機質な【主語＋動詞】に書き直して先入観を防ぐ（既定ON・切替で原見出し）。
// あわせて著作権面でも「見出しの自前再表現」になる（配信見出しをそのまま主表示にしない）。
// 外国語見出しは日本語の中立見出しになる（翻訳を兼ねる）。
// 使い方:  node --env-file=.env neutralize.mjs [out-ingest.json]  →  out-headlines.json {原見出し: 中立見出し}

import { readFileSync, writeFileSync } from 'node:fs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
function need(n) { const v = process.env[n]; if (!v) { console.error(n + ' が未設定です。'); process.exit(1); } return v; }

async function neutralizeBatch(titles) {
  const key = need('GEMINI_API_KEY');
  const sys = 'あなたは中立で誠実な見出しの書き直し係。ニュース見出しを、次の規則で日本語の「中立見出し」に書き直す。' +
    '①事実だけ（誰/何が・何をした）。評価語・煽り・比喩・感嘆・「衝撃」「悲劇」等の感情語を除く' +
    '②原文の語順・言い回しをなぞらず自分の言葉で（事実の再表現）' +
    '③外国語の見出しは日本語にする' +
    '④元見出しに無い情報を足さない・推測しない' +
    '⑤30字以内を目安に簡潔に。' +
    '入力と同じ番号・同じ順で、中立見出しだけを1行ずつ返す。説明を付けない。';
  const user = titles.map((t, i) => (i + 1) + '. ' + t).join('\n');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + key;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, maxOutputTokens: 4096 } }),
  });
  if (!res.ok) throw new Error('neutralize ' + res.status + ' ' + (await res.text()).slice(0, 100));
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  return out.split('\n').map(l => l.replace(/^\s*\d+[.)、]\s*/, '').trim()).filter(Boolean);
}

async function main() {
  const d = JSON.parse(readFileSync(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'out-ingest.json', 'utf8'));
  // 気象庁の定時電文（「降灰予報（定時）」等）は既に無機質＝書き直し不要。報道見出しだけを対象に。
  const titles = [...new Set((d.headlines || []).filter(h => h.kind !== 'prim' && h.title).map(h => h.title))];
  // 差分処理：前回の出力を読み、未処理の見出しだけAPIへ（無料枠が1日20回に縮小されたため必須）
  let old = {};
  try { old = JSON.parse(readFileSync('out-headlines.json', 'utf8')).headlines || {}; } catch (e) {}
  if (!titles.length) {
    if (Object.keys(old).length) { console.error('対象見出しなし→前回データ温存'); return; }
    writeFileSync('out-headlines.json', JSON.stringify({ headlines: {} }, null, 2)); console.error('対象見出しなし。'); return;
  }
  const pending = titles.filter(t => !old[t]);
  let ja = [];
  if (pending.length) {
    for (let t = 0; t < 3; t++) {
      try { ja = await neutralizeBatch(pending); break; }
      catch (e) {
        if (t === 2) { console.error('  中立見出し生成失敗（無料枠の混雑/枯渇？）: ' + e.message); break; }
        await new Promise(r => setTimeout(r, Math.min(500 * 2 ** t, 8000)));
      }
    }
    // 行数不一致＝対応関係が保証できない→全破棄（別見出しの中立版が付く事故を防ぐ。translate.mjsと同じ規律）
    if (ja.length !== pending.length) {
      if (ja.length) console.error('  行数不一致（入力' + pending.length + '/出力' + ja.length + '）→ 全破棄。原見出しのまま表示されます。');
      ja = [];
    }
  } else {
    console.error('  新規見出しなし＝API呼び出しゼロ（差分処理）');
  }
  const headlines = {};
  titles.forEach(t => { if (old[t]) headlines[t] = old[t]; });   // 処理済みは再利用（現行見出し分のみ＝無限肥大防止）
  pending.forEach((t, i) => { if (ja[i]) headlines[t] = ja[i]; });
  // 枯渇/失敗で0件になった時、既にある良いデータを空で上書きしない（前回データを温存）
  if (!Object.keys(headlines).length) {
    try { const o = JSON.parse(readFileSync('out-headlines.json','utf8')); if (Object.keys(o.headlines||{}).length) { console.error('  0件→前回の中立見出しを温存'); return; } } catch(e){}
  }
  writeFileSync('out-headlines.json', JSON.stringify({ note: '中立見出し（ブラインド見出し）＝評価語を除いた事実の再表現・自前の言葉。既定表示に使い、原見出しは切替で見られる。', headlines }, null, 2));
  console.error('中立見出し ' + Object.keys(headlines).length + '/' + titles.length + ' 件（新規' + pending.length + '・再利用' + titles.filter(t => old[t]).length + '） → out-headlines.json');
  Object.entries(headlines).slice(0, 3).forEach(([k, v]) => console.error('  ' + k.slice(0, 26) + ' → ' + v));
}

main().catch(e => { console.error(e); process.exit(1); });
