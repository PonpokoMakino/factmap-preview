#!/usr/bin/env node
// ファクトマップ 論理マッピングエンジン（プロトタイプ・ライブ版 v0.2／マルチプロバイダ）
// 実記事テキスト → LLM API で構造化JSON（各 fact / position に span 付き）を生成する。
// プロバイダ切替可能。既定は「無料枠のある Google Gemini」（牧野様の支出ゼロ方針に合わせる）。
//
// 使い方:
//   # Gemini（無料枠・既定。Google AI Studio で無料発行・カード不要）
//   GEMINI_API_KEY=xxx node engine.mjs samples/sample-01.txt
//   # Anthropic Claude（口座に資金が要る）
//   FACTMAP_PROVIDER=anthropic ANTHROPIC_API_KEY=xxx node engine.mjs samples/sample-01.txt
//   # OpenAI（最安は gpt-4.1-nano。無料枠なし）
//   FACTMAP_PROVIDER=openai OPENAI_API_KEY=xxx node engine.mjs samples/sample-01.txt
//
// モデルは環境変数で上書き可（GEMINI_MODEL / ANTHROPIC_MODEL / OPENAI_MODEL）。

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const PROVIDER = (process.env.FACTMAP_PROVIDER || 'gemini').toLowerCase();
const USER_PREFIX = '次のニュース記事を、システムプロンプトのJSONフォーマット（各 fact / position に span 付き）だけで構造化してください。JSON以外は出力しないこと。\n\n---\n';

function need(name){ const v = process.env[name]; if(!v){ console.error(name + ' が未設定です。'); process.exit(1); } return v; }

// --- プロバイダ別の呼び出し（戻り値＝生成テキスト） ---
async function callGemini(sys, user){
  const key = need('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    })
  });
  if(!res.ok){ console.error('Gemini APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callAnthropic(sys, user){
  const key = need('ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || process.env.FACTMAP_MODEL || 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8192, temperature: 0, system: sys,
      messages: [{ role: 'user', content: user }] })
  });
  if(!res.ok){ console.error('Anthropic APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

async function callOpenAI(sys, user){
  const key = need('OPENAI_API_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] })
  });
  if(!res.ok){ console.error('OpenAI APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const PROVIDERS = { gemini: callGemini, anthropic: callAnthropic, openai: callOpenAI };

// ★天才エンジン v0.3＝3段構造：①抽出 → ②機械の関所（無料・確実） → ③別人格のAI検品。
// 「一人の天才」でなく「書く人・関所・検品係」の構造で品質を作る（中立の鉄則の運用実装）。

// ②機械の関所：LLMに頼らずコードで確実に検査できるものはコードで（無料・毎回・嘘をつかない）
function mechAudit(obj, article){
  const issues = [];
  // (a) span実在チェック＝幻覚の除去：元テキストに一字一句存在しない引用は空にする
  const checkSpan = (item, kind) => {
    if (item && item.span && !article.includes(item.span)) { issues.push(kind + ' spanが原文に無い→除去「' + String(item.span).slice(0, 18) + '…」'); item.span = ''; }
  };
  (obj.facts || []).forEach(f => checkSpan(f, 'fact'));
  (obj.positions || []).forEach(p => checkSpan(p, 'position'));
  // (b) 媒体名の照合＝出典の捏造防止：入力に [出典: X] ラベルがある場合、そこに無い媒体名のsrcは落とす
  const labels = [...article.matchAll(/\[出典:\s*([^\]]+)\]/g)].map(m => m[1].trim());
  if (labels.length) {
    const known = l => labels.some(x => x.includes(l) || l.includes(x));
    for (const arr of [obj.facts || [], obj.positions || []])
      for (const it of arr)
        it.src = (it.src || []).filter(s => { const ok = !s.l || known(s.l); if (!ok) issues.push('出典が入力に無い→除去「' + s.l + '」'); return ok; });
  }
  // (c) 論理構造タグの範囲検査：存在しない添字への premises/counters は落とす（構造の破れ防止）
  const nf = (obj.facts || []).length, np = (obj.positions || []).length;
  (obj.positions || []).forEach(p => {
    if (Array.isArray(p.premises)) p.premises = p.premises.filter(i => Number.isInteger(i) && i >= 0 && i < nf);
    if (Array.isArray(p.counters)) p.counters = p.counters.filter(i => Number.isInteger(i) && i >= 0 && i < np);
  });
  return issues;
}

async function main(){
  const path = process.argv[2];
  if(!path){ console.error('使い方: node engine.mjs <記事テキストファイル>'); process.exit(1); }
  const call = PROVIDERS[PROVIDER];
  if(!call){ console.error('未知のプロバイダ: ' + PROVIDER + '（gemini|anthropic|openai）'); process.exit(1); }

  const [article, sys] = await Promise.all([
    readFile(path, 'utf8'),
    readFile(join(__dir, 'prompts', 'engine-system-prompt.md'), 'utf8')
  ]);

  // ①抽出パス
  const text = (await call(sys, USER_PREFIX + article)).trim();
  let obj;
  try { obj = JSON.parse(extractJson(text)); }
  catch(e){ console.error('JSONパース失敗。生出力:\n' + text); process.exit(1); }

  // ②機械の関所（抽出直後）
  const mechIssues = mechAudit(obj, article);

  // ③別人格のAI検品（FACTMAP_VERIFY=0 で抽出のみ＝旧動作・score測定用）
  let auditNote = { changed: false, issues: [] };
  if (process.env.FACTMAP_VERIFY !== '0') {
    try {
      const sys2 = await readFile(join(__dir, 'prompts', 'engine-verify-prompt.md'), 'utf8');
      const user2 = '【元テキスト】\n' + article + '\n\n【抽出エンジンのJSON】\n' + JSON.stringify(obj) + '\n\n監査観点に照らして修正済みJSON全体（audit付き）だけを返してください。';
      const vObj = JSON.parse(extractJson((await call(sys2, user2)).trim()));
      if (vObj && Array.isArray(vObj.facts)) {   // 検品側の壊れた応答で良い抽出を潰さない
        auditNote = vObj.audit || auditNote;
        delete vObj.audit;
        obj = vObj;
        mechAudit(obj, article);   // 検品後にもう一度関所（検品側の幻覚も除去）
      } else { auditNote.issues.push('検品応答が不正形式→抽出のみ採用'); }
    } catch (e) { auditNote.issues.push('検品パス失敗（' + String(e.message || e).slice(0, 60) + '）→抽出のみ採用'); }
  }
  obj.audit = { changed: !!auditNote.changed, issues: [...(auditNote.issues || []), ...mechIssues] };
  console.log(JSON.stringify(obj, null, 2));
}

// モデル出力からJSON本体だけを取り出す。
// ①コードフェンス（```json ... ```）があれば中身を優先 ②なければ最初の { から括弧の深さを数えて対応する } まで
// （旧実装の貪欲マッチ /\{[\s\S]*\}/ は、JSONの後ろに説明文や { } を含む文が続くとゴミを巻き込んで失敗した）
function extractJson(text){
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence) return fence[1].trim();
  const start = text.indexOf('{');
  if(start === -1) return text;
  let depth = 0, inStr = false, escaped = false;
  for(let i = start; i < text.length; i++){
    const c = text[i];
    if(escaped){ escaped = false; continue; }
    if(c === '\\'){ if(inStr) escaped = true; continue; }
    if(c === '"'){ inStr = !inStr; continue; }
    if(inStr) continue;
    if(c === '{') depth++;
    else if(c === '}'){ depth--; if(depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

main().catch(e => { console.error(e); process.exit(1); });
