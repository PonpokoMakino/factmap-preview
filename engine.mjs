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
async function callGemini(sys, article){
  const key = need('GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      system_instruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: USER_PREFIX + article }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' }
    })
  });
  if(!res.ok){ console.error('Gemini APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function callAnthropic(sys, article){
  const key = need('ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || process.env.FACTMAP_MODEL || 'claude-sonnet-4-6';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 8192, temperature: 0, system: sys,
      messages: [{ role: 'user', content: USER_PREFIX + article }] })
  });
  if(!res.ok){ console.error('Anthropic APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

async function callOpenAI(sys, article){
  const key = need('OPENAI_API_KEY');
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: USER_PREFIX + article }] })
  });
  if(!res.ok){ console.error('OpenAI APIエラー', res.status, await res.text()); process.exit(1); }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const PROVIDERS = { gemini: callGemini, anthropic: callAnthropic, openai: callOpenAI };

async function main(){
  const path = process.argv[2];
  if(!path){ console.error('使い方: node engine.mjs <記事テキストファイル>'); process.exit(1); }
  const call = PROVIDERS[PROVIDER];
  if(!call){ console.error('未知のプロバイダ: ' + PROVIDER + '（gemini|anthropic|openai）'); process.exit(1); }

  const [article, sys] = await Promise.all([
    readFile(path, 'utf8'),
    readFile(join(__dir, 'prompts', 'engine-system-prompt.md'), 'utf8')
  ]);

  const text = (await call(sys, article)).trim();
  const json = extractJson(text);
  try { console.log(JSON.stringify(JSON.parse(json), null, 2)); }
  catch(e){ console.error('JSONパース失敗。生出力:\n' + text); process.exit(1); }
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
