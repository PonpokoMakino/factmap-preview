#!/usr/bin/env node
// ファクトマップ 論点マップ化（取り込み→束ね→★司書型マップ★ の最後の一段・最小版 v0.1）
// 束ねた出来事（cluster.mjsの出力）の見出し＋スニペットを engine に通し、争点・事実・立場を取り決めAで構造化する。
// ★本文は使わない（配信スニペットのみ）。事実は engine が自前の言葉で書き直す。
// 使い方:  node map.mjs [out-events.json] [--top 4]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const inPath = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) || 'out-events.json';
const top = (() => { const i = process.argv.indexOf('--top'); return i >= 0 ? parseInt(process.argv[i + 1], 10) || 4 : 4; })();

const data = JSON.parse(readFileSync(inPath, 'utf8'));
// 論点が立ちやすい＝独立2社以上の出来事を上位から（事実合意型は立場が空でも可）
const targets = (data.events || []).filter(e => e.independentSources >= 2).slice(0, top);

mkdirSync('samples', { recursive: true });   // CI等samplesが無い環境でも動くように
function runEngine(text) {
  writeFileSync('samples/ingest-map-tmp.txt', text);
  // ⚠️無料枠は縮小され flash-lite も1日20回まで（2026-07実測）。呼び出しは最小限に。
  // モデルfallback：枠は「1日20回/モデル」＝モデル別勘定。2回目まで主モデル・3回目は控え(flash)へ。
  const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  for (let t = 0; t < 3; t++) {
    const model = MODELS[Math.min(Math.floor(t / 2), MODELS.length - 1)];
    try {
      const j = execFileSync('node', ['--env-file=.env', 'engine.mjs', 'samples/ingest-map-tmp.txt'],
        { env: { ...process.env, GEMINI_MODEL: model }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (t === 2 && MODELS.length > 1) console.error('  ↪ 控えモデル(' + model + ')で成功');
      return JSON.parse(j);
    } catch (e) {
      // 503混雑・429枯渇は指数バックオフで待ってから再試行（無待機連打は無料枠を溶かすだけ）
      const wait = Math.min(500 * 2 ** t, 8000);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
  return null;
}

// 差分処理：前回のマップを読み、同じ出来事（slug一致）は再生成せず再利用（無料枠20回/日の節約）
let oldMaps = [];
try { oldMaps = JSON.parse(readFileSync('out-maps.json', 'utf8')).maps || []; } catch (e) {}
const oldByKey = new Map(oldMaps.map(m => [m.slug || m.headline, m]));

const maps = [];
let freshCount = 0;
for (const e of targets) {
  const prev = oldByKey.get(e.slug || e.headline);
  if (prev) { maps.push(prev); console.error('  ↻ 再利用: ' + e.headline.slice(0, 24)); continue; }
  // 入力＝束ねた各見出し＋配信スニペット（本文ではない）。
  // [出典: 媒体名] を明示して渡す＝engineが媒体名を推測・捏造しないように（src.l はこのラベルから選ばせる）。
  const text = e.members.map(m => '[出典: ' + m.source + '] ' + m.title + (m.snippet ? '。' + m.snippet : '')).join('\n');
  const out = runEngine(text);
  if (!out) { console.error('  ✗ 失敗: ' + e.headline.slice(0, 24)); continue; }
  freshCount++;
  // 確定的な番人：賛成(support)と反対(attack)が両方そろって初めて「賛否が割れる」。
  // 片方しか無い・全部中立などは賛否が割れていない＝事実合意型として立場を空にする（弱いモデルの立場の作りすぎを防ぐ）。
  const ps = out.positions || [];
  const split = ps.some(p => p.stance === 'support') && ps.some(p => p.stance === 'attack');
  maps.push({
    headline: e.headline,
    slug: e.slug || '',
    independentSources: e.independentSources,
    sources: e.sources,
    links: e.members.map(m => ({ source: m.source, link: m.link })),
    issue: out.issue, stasis: out.stasis,
    facts: out.facts || [], positions: split ? ps : [],
    consensus: out.consensus, note: out.note,
    audit: out.audit,   // 検品記録（透明性：何を直したかを隠さない）
  });
}

// 枯渇/失敗でマップが減った時、既にある良いデータを上書きしない（前回データを温存）
try { const old = JSON.parse(readFileSync('out-maps.json','utf8')); if ((old.maps||[]).length > maps.length) { console.error('  ' + maps.length + '件<前回' + old.maps.length + '件→前回の論点マップを温存'); process.exit(0); } } catch(e){}
writeFileSync('out-maps.json', JSON.stringify({ builtAt: data.rankedAt, note: '配信スニペット由来・本文非使用。事実はengineが自前の言葉で再表現。', maps }, null, 2));
console.error('\n■ 論点マップ生成（取り込み→束ね→司書型マップ）');
maps.forEach(m => console.error(`  ✅ [${m.independentSources}社] ${m.headline.slice(0, 26)} → 争点「${(m.issue || '').slice(0, 24)}」/ 事実${m.facts.length}・立場${m.positions.length}`));
console.error(`  計 ${maps.length} 件（新規${freshCount}・再利用${maps.length - freshCount}） → out-maps.json`);
