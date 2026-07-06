#!/usr/bin/env node
// ファクトマップ クラスタリング（本番ホーム「ボリューム順タイムライン」の最小版 v0.1）
// 目的：取り込んだ見出しを「同じ出来事」で束ね、★独立した報道社の数★で並べる。
//   ＝声の大きさ(engagement)でなく「何社が独立に報じたか」で重要度を測る（設計図の中核・アジェンダを機械的に薄める）。
// 入力：ingest.mjs のJSON（ファイル引数 or 標準入力）。  例: node ingest.mjs --max 10 | node cluster.mjs
//
// ※簡易版：日本語見出しから漢字/カタカナの語を取り出し、意味のある共通語で束ねる（本番は埋め込みembeddingに置換予定）。

import { readFileSync } from 'node:fs';

// 一般語（出来事の同一性に効かない語）は束ねの手がかりから除く
const STOP = new Set('ニュース 映像 上空 時点 まとめ けが 行方 不明 報道 日本 午前 午後 見通し 専門家 想定 設置 訓練 可能 関連 一覧 速報 注意 警戒 おそれ 状況 影響 各地 今後 さらに'.split(/\s+/));

// 英語の一般語（出来事の同一性に効かない語）
const STOP_EN = new Set('the a an and or of in on at to for with from by as is are was were be been has have had will would this that these those after amid says say said new over more most other'.split(/\s+/));
// 国名・国籍語：話題の手がかりにはなる（shared にはカウント）が、1語だけで同一出来事とは言えない
// （例 'russian' がキエフ攻撃とマリのヘリ撃墜を誤束ねした実例 2026-07-06）＝ strong 判定からは除外
const GEO_EN = new Set('russia russian ukraine ukrainian china chinese iran iranian israel israeli gaza japan japanese america american korea korean india indian europe european syria syrian venezuela london washington moscow beijing tokyo kyiv'.split(/\s+/));

// 簡易ステミング：語形違い（indicts/indicted→indict）を揃える
function stemEn(t) {
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('ing') && t.length >= 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length >= 5) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function tokens(s) {
  const text = s || '';
  // 日本語（漢字・カタカナの連なり）
  const ja = (text.match(/[一-龥ァ-ヶー々〆]{2,}/g) || []).filter(t => !STOP.has(t));
  // 英語（3文字以上・小文字化・一般語除去・簡易ステミング）＝海外フィード(lang≠ja)も束ねられるように
  const en = (text.toLowerCase().match(/[a-z]{3,}/g) || []).filter(t => !STOP_EN.has(t)).map(stemEn).filter(t => t.length >= 3 && !STOP_EN.has(t));
  return [...ja, ...en];
}

function readInput() {
  const arg = process.argv[2];
  if (arg && arg !== '-') return JSON.parse(readFileSync(arg, 'utf8'));
  return JSON.parse(readFileSync(0, 'utf8')); // stdin
}

// 埋め込み（embed.mjsの出力）があれば読み込む。無ければキーワード束ねのみで動く（後方互換）。
function readEmbeds() {
  try { return JSON.parse(readFileSync('out-embeds.json', 'utf8')).vectors || {}; } catch (e) { return {}; }
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function main() {
  const data = readInput();
  const items = data.headlines || [];
  const N = items.length;
  if (!N) { console.error('見出しがありません。'); process.exit(1); }

  // 日本語はタイトル＋スニペットで束ねる（有効）。英語スニペットは 'World Cup 2026' 等の定型語で
  // 別の出来事まで連鎖しやすいため、英語トークンはタイトルのみから取る。
  const toks = items.map(it => {
    const jaAll = tokens(it.title + ' ' + (it.snippet || '')).filter(t => !/^[a-z]/.test(t));
    const enTitle = tokens(it.title).filter(t => /^[a-z]/.test(t));
    return new Set([...jaAll, ...enTitle]);
  });
  const df = {};
  toks.forEach(s => s.forEach(t => df[t] = (df[t] || 0) + 1));

  // union-find（単一リンク・クラスタリング）
  const par = items.map((_, i) => i);
  const find = x => par[x] === x ? x : (par[x] = find(par[x]));
  const uni = (a, b) => { par[find(a)] = find(b); };

  // 2見出しが同一出来事か：チェーン束ねを防ぐため「意味のある共通語」or「希少な固有語」を要求。
  // 英語は 'world cup' 等の一般語ペアで別試合まで連鎖しやすい＝日本語(2語)より厳しく3語 or 希少長語1つ。
  // 過剰束ねは「独立報道社数」を水増しして重要度を歪める＝under-merge(取りこぼし)の方が中立には安全。
  // しきい値の設計（意図的に3段階）：一般語の除外=N*0.5（半数超に出る語は無意味）／
  // 日本語のstrong=N*0.4（漢字語は固有性が高く緩め）／英語のstrong=N*0.1（英語は同語彙が頻出するため厳しめ）。
  // ※これは経験則の暫定値。本番はembedding（意味の近さ）に置換予定（--embed対応済み）。
  // 一次情報(prim)同士の束ねキー＝【火山名/地域名】ブラケット、無ければ snippet 冒頭の地名句。
  // JMA電文は定型文言（噴火警戒レベル・火口周辺規制等）が多く、df基準では別火山・別県の電文が誤束ねされる
  // （2026-07-06 Fable5検品：7火山の降灰予報が1出来事に潰れた実害）→ prim同士はキー一致のみで束ねる。
  function primKey(it) {
    const m = (it.snippet || '').match(/【([^】]+)】/);
    if (m) return m[1];
    const m2 = (it.snippet || '').match(/^([^、。\s]{2,12})(?:では|に|の)/);
    return m2 ? m2[1] : '';
  }
  function linked(i, j) {
    if (items[i].ty === 'prim' && items[j].ty === 'prim') {
      const ka = primKey(items[i]), kb = primKey(items[j]);
      return !!(ka && kb && ka === kb);   // 同じ火山/地域の続報のみ束ねる（定型文言では束ねない）
    }
    let sharedJa = 0, sharedEn = 0, strong = false;
    for (const t of toks[i]) {
      if (!toks[j].has(t)) continue;
      if (df[t] > Math.max(2, N * 0.5)) continue;                 // 全体の半数超に出る一般語は無視
      if (/^[a-z]/.test(t)) {
        sharedEn++;
        if (t.length >= 6 && df[t] <= Math.max(2, N * 0.1) && !GEO_EN.has(t)) strong = true;  // 英語：長く希少な語（indict等）。国名・国籍語は除外
      } else {
        sharedJa++;
        if (t.length >= 4 && df[t] <= Math.max(2, N * 0.4)) strong = true;  // 日本語：長く希少な固有語
      }
    }
    return strong || sharedJa >= 2 || (sharedJa + sharedEn) >= 3;
  }
  // 埋め込み（意味の近さ）：あればキーワード規則とORで併用。
  // しきい値0.75＝実データ較正（2026-07-06・45見出し）：0.75以上はほぼ全て同一/密接関連ペアだった。
  // ※0.51〜0.75にも関連度の高い別事件ペアが混在する（明確な分離帯ではない）＝下げる時は要再検証。
  const EMB = readEmbeds();
  const EMBED_TH = parseFloat(process.env.EMBED_TH || '0.75');
  function linkedByEmbed(i, j) {
    const a = EMB[items[i].title], b = EMB[items[j].title];
    return !!(a && b && cosine(a, b) >= EMBED_TH);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (linked(i, j) || linkedByEmbed(i, j)) uni(i, j);

  const groups = {};
  for (let i = 0; i < N; i++) { const r = find(i); (groups[r] = groups[r] || []).push(i); }

  const events = Object.values(groups).map(idxs => {
    const sources = new Set(idxs.map(i => items[i].source));
    const rep = idxs.map(i => items[i]).sort((a, b) => b.title.length - a.title.length)[0];
    // 出来事の時刻＝メンバー中の最新（パースできるものだけ）
    const times = idxs.map(i => new Date(items[i].time || '')).filter(d => !isNaN(d));
    const latest = times.length ? new Date(Math.max(...times)).toISOString() : '';
    return {
      headline: rep.title,
      slug: rep.title.replace(/[^一-龥ぁ-んァ-ヶa-zA-Z0-9]/g, '').slice(0, 24),  // 詳細ページへの直リンク用ID
      time: latest,                             // 出来事の時刻（メンバー中の最新）
      independentSources: sources.size,         // ★独立した報道社の数（volume）
      sources: [...sources],
      count: idxs.length,
      hasPrimary: idxs.some(i => items[i].ty === 'prim'),   // 一次情報（官公庁の発表）を含むか
      members: idxs.map(i => ({ title: items[i].title, snippet: items[i].snippet, source: items[i].source, link: items[i].link, ty: items[i].ty, linkKind: items[i].linkKind || 'article' })),
    };
  });

  // ボリューム順＝独立社数 → 件数（声の大きさでなく独立報道数で並べる）
  events.sort((a, b) => b.independentSources - a.independentSources || b.count - a.count);

  console.log(JSON.stringify({ rankedAt: data.fetchedAt, lens: '独立報道社数(volume)順', events }, null, 2));
  console.error('\n■ 出来事ランキング（独立報道社数順＝"何社が独立に報じたか"で重要度を測る）');
  events.forEach((e, i) => console.error(`  ${i + 1}. [${e.independentSources}社/${e.count}本] ${e.headline}  〔${e.sources.join('・')}〕`));
}

main();
