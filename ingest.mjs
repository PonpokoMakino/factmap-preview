#!/usr/bin/env node
// ファクトマップ 取り込みワーカー（本番パイプラインの最小版 v0.1）
// ★鉄則：本文は取得・保存しない。配信目的で公開されたRSSの「見出し・要約スニペット・リンク・媒体・時刻」だけを取る。
//   事実の抽出は、この後 engine が見出し＋スニペット＋一次情報から「自前の中立な言葉」で書き直す（本文の複製はしない）。
//   ＝著作権の鉄則「本文は溜めない／事実は自前で再表現／元記事へはリンク」をコードで体現。
//
// 使い方:  node ingest.mjs            （既定フィードを取り込み、JSONで出力）
//          node ingest.mjs --max 5    （各フィード上位5件）

const FEEDS = [
  // 国内・報道（press・日本語）
  { name: 'NHK 主要ニュース', url: 'https://www.nhk.or.jp/rss/news/cat0.xml', kind: 'press', lang: 'ja' },
  { name: 'Yahoo!ニュース 主要', url: 'https://news.yahoo.co.jp/rss/topics/top-picks.xml', kind: 'press', lang: 'ja' },
  { name: '時事ドットコム', url: 'https://www.jiji.com/rss/ranking.rdf', kind: 'press', lang: 'ja' },
  // 国内・一次情報（prim・日本語）＝官公庁の発表（著作権が緩く・アプリ最重視のインプット。Atom形式）
  { name: '気象庁 地震・火山', url: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', kind: 'prim', lang: 'ja' },
  { name: '気象庁 気象警報・注意報', url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml', kind: 'prim', lang: 'ja' },
  // 海外・報道（press・英語）＝北極星(グローバル化)。見出し/スニペットは取り込み、日本語訳はengineが行う（原文リンク保持）。
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', kind: 'press', lang: 'en' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', kind: 'press', lang: 'en' },
];

const argMax = (() => { const i = process.argv.indexOf('--max'); return i >= 0 ? parseInt(process.argv[i + 1], 10) || 5 : 5; })();

// XMLの最初のタグ内容を取り出す（CDATA対応・本文ではなくRSSの構造化メタを読むだけ）
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

// Atom の <link href="..."/> は属性なので別取り
function atomLink(block) { const m = block.match(/<link[^>]*href="([^"]+)"/i); return m ? m[1] : ''; }

function parseItems(xml) {
  // RSS(<item>) と Atom(<entry>) の両対応
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) || [];
  return blocks.map(b => ({
    title: tag(b, 'title'),
    // 配信用の短い要約（description/summary/content）。先頭120字に切る（本文の代替にしない）。
    snippet: (tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 120),
    link: tag(b, 'link') || atomLink(b),
    time: tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'dc:date'),
  })).filter(it => it.title);
}

async function fetchFeed(feed) {
  try {
    // タイムアウト10秒：1フィードの無応答が取り込み全体を巻き込まないように
    const res = await fetch(feed.url, { headers: { 'user-agent': 'factmap-ingest/0.1 (+research)' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ...feed, ok: false, error: 'HTTP ' + res.status, items: [] };
    const xml = await res.text();
    // kind=prim は一次情報（出典種別 ty=prim）、それ以外は報道（ty=press）
    const ty = feed.kind === 'prim' ? 'prim' : 'press';
    const items = parseItems(xml).slice(0, argMax).map(it => {
      const out = { ...it, source: feed.name, kind: feed.kind || 'press', ty, lang: feed.lang || 'ja' };
      // 一次情報(気象庁等)のAtomリンクは生の電文XMLを指す＝「元記事」でなく「元データ(XML)」。
      // 人間が読めるページでないため、linkKind=data を付け、UI側でラベルを出し分ける。
      if (feed.kind === 'prim' && /\.xml($|\?)/i.test(out.link || '')) out.linkKind = 'data';
      return out;
    });
    // 一次情報の中身接地：電文XML本体から見出し文（<Headline><Text>）を取り出して snippet に。
    // 官公庁の公共データ＝著作権面で安全な一次テキスト。これで「一次情報が薄い」問題を解消（エンジンの根拠にもなる）。
    if (feed.kind === 'prim') {
      await Promise.all(items.map(async it => {
        if (it.linkKind !== 'data' || it.snippet) return;
        try {
          const r = await fetch(it.link, { headers: { 'user-agent': 'factmap-ingest/0.1 (+research)' }, signal: AbortSignal.timeout(8000) });
          if (!r.ok) return;
          const body = await r.text();
          const m = body.match(/<Headline>[\s\S]*?<Text>([\s\S]*?)<\/Text>/) || body.match(/<Text>([\s\S]*?)<\/Text>/);
          if (m) it.snippet = m[1].replace(/\s+/g, ' ').trim().slice(0, 120);
        } catch (e) { /* 電文取得失敗は無視（snippetなしのまま） */ }
      }));
    }
    return { ...feed, ok: true, items };
  } catch (e) {
    return { ...feed, ok: false, error: String(e.message || e), items: [] };
  }
}

async function main() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const headlines = results.flatMap(r => r.items);
  const out = {
    fetchedAt: new Date().toISOString(),
    note: '本文は未取得・未保存（配信RSSの見出し/スニペット/リンク/時刻のみ）。事実抽出はengineが自前の言葉で行う。',
    feeds: results.map(r => ({ name: r.name, ok: r.ok, error: r.error || null, count: r.items.length })),
    headlines,
  };
  console.log(JSON.stringify(out, null, 2));
  // 人間向けの短い要約は stderr へ（stdout はJSONのみ＝後段に渡せる）
  console.error('\n■ 取り込み結果（本文は溜めていません）');
  for (const r of results) console.error(`  ${r.ok ? '✅' : '🟥'} ${r.name}: ${r.ok ? r.items.length + '件' : r.error}`);
  console.error(`  合計 ${headlines.length} 本の見出しを取得（リンクで元記事へ誘導）。`);
}

main().catch(e => { console.error(e); process.exit(1); });
