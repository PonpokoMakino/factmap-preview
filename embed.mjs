#!/usr/bin/env node
// ファクトマップ 見出し埋め込み（embedding）v0.1
// 設計図「クラスタリング：embeddingの近傍検索で同一出来事を束ねる」の実装。キーワード束ねの本番化。
// 無料Geminiの埋め込みAPI（text-embedding-004）で各見出しをベクトル化 → out-embeds.json。
// cluster.mjs が存在すれば自動で併用する（キーワード規則 OR コサイン類似度）。
// 使い方:  node --env-file=.env embed.mjs [out-ingest.json]

import { readFileSync, writeFileSync } from 'node:fs';

// ※text-embedding-004は2026年時点で404（提供終了）。gemini-embedding-001（3072次元・無料枠あり）を既定に。
const MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
function need(n) { const v = process.env[n]; if (!v) { console.error(n + ' が未設定です。'); process.exit(1); } return v; }

async function embedBatch(texts) {
  const key = need('GEMINI_API_KEY');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':batchEmbedContents?key=' + key;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ requests: texts.map(t => ({ model: 'models/' + MODEL, content: { parts: [{ text: t }] } })) }),
  });
  if (!res.ok) throw new Error('embed ' + res.status + ' ' + (await res.text()).slice(0, 100));
  const data = await res.json();
  return (data.embeddings || []).map(e => e.values || []);
}

async function main() {
  const d = JSON.parse(readFileSync(process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'out-ingest.json', 'utf8'));
  // 定時電文（降灰予報等の同名多発）はキーワード束ねで十分＝埋め込み対象は報道見出しのみ
  const titles = [...new Set((d.headlines || []).filter(h => h.kind !== 'prim' && h.title).map(h => h.title))];
  if (!titles.length) { writeFileSync('out-embeds.json', JSON.stringify({ vectors: {} })); console.error('対象なし。'); return; }
  let vecs = [];
  for (let t = 0; t < 5; t++) {
    try { vecs = await embedBatch(titles); break; }
    catch (e) {
      if (t === 4) { console.error('  埋め込み失敗（無料枠の混雑/枯渇？）: ' + e.message); break; }
      await new Promise(r => setTimeout(r, Math.min(500 * 2 ** t, 8000)));
    }
  }
  const vectors = {};
  if (vecs.length === titles.length) titles.forEach((t, i) => { vectors[t] = vecs[i]; });
  writeFileSync('out-embeds.json', JSON.stringify({ model: MODEL, note: '見出しの意味ベクトル。cluster.mjsがコサイン類似度で同一出来事の束ねに併用。', vectors }));
  console.error('埋め込み ' + Object.keys(vectors).length + '/' + titles.length + ' 件 → out-embeds.json（次元=' + (vecs[0] ? vecs[0].length : 0) + '）');
}

main().catch(e => { console.error(e); process.exit(1); });
