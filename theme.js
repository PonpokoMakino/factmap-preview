/* ファクトマップ 表示設定（デザイン選択）v1.0
   ユーザーがテーマ・文字サイズを選べる（ヘッドレス設計＝中身は同じ・見せ方だけ変わる）。
   中立の条件：どのテーマも情報の中身・順序・色の意味（賛成=青/反対=橙・赤緑禁止）は変えない。
   選択は localStorage に保存され全ページ共通で効く。 */
(function(){
  var THEMES = {
    light: { bg:'#fbfbfa', bg2:'#f4f4f2', ink:'#15181d', ink2:'#4b515b', ink3:'#6b7280', line:'#e6e6e2', line2:'#efefea',
      accent:'#2a6f6b', accentBg:'rgba(42,111,107,.06)',
      support:'#2563eb', attack:'#c2410c', neutral:'#6b7280',
      supportBg:'rgba(37,99,235,.045)', attackBg:'rgba(194,65,12,.05)', neutralBg:'rgba(107,114,128,.05)' },
    dark: { bg:'#131316', bg2:'#1b1c20', ink:'#e9ebef', ink2:'#aab0ba', ink3:'#9aa1ac', line:'#2a2c31', line2:'#23252a',
      accent:'#7fbcb6', accentBg:'rgba(127,188,182,.10)',
      support:'#6aa5fb', attack:'#fb923c', neutral:'#9ca3af',
      supportBg:'rgba(106,165,251,.09)', attackBg:'rgba(251,146,60,.09)', neutralBg:'rgba(156,163,175,.08)' },
    paper: { bg:'#f6f1e5', bg2:'#eee7d6', ink:'#2b2620', ink2:'#5a5244', ink3:'#7c7362', line:'#ded3bc', line2:'#e7ddc9',
      accent:'#2a6f6b', accentBg:'rgba(42,111,107,.08)',
      support:'#1d4ed8', attack:'#b45309', neutral:'#6b7280',
      supportBg:'rgba(29,78,216,.05)', attackBg:'rgba(180,83,9,.06)', neutralBg:'rgba(107,114,128,.06)' }
  };
  var FONTS = { normal:'1', large:'1.12', xlarge:'1.25' };

  function cssFor(t){
    return ':root[data-theme]{' +
      '--bg:'+t.bg+';--bg-2:'+t.bg2+';--ink:'+t.ink+';--ink-2:'+t.ink2+';--ink-3:'+t.ink3+';' +
      '--line:'+t.line+';--line-2:'+t.line2+';--accent:'+t.accent+';--accent-bg:'+t.accentBg+';' +
      '--support:'+t.support+';--attack:'+t.attack+';--neutral:'+t.neutral+';' +
      '--support-bg:'+t.supportBg+';--attack-bg:'+t.attackBg+';--neutral-bg:'+t.neutralBg+';}';
  }

  var styleEl = document.createElement('style');
  document.head.appendChild(styleEl);

  function apply(){
    var theme = localStorage.getItem('fm-theme') || 'auto';
    var font = localStorage.getItem('fm-font') || 'normal';
    if(theme === 'auto'){
      document.documentElement.removeAttribute('data-theme');
      styleEl.textContent = '';
    } else {
      document.documentElement.setAttribute('data-theme', theme);
      styleEl.textContent = cssFor(THEMES[theme] || THEMES.light);
    }
    document.body && (document.body.style.zoom = FONTS[font] || '1');
  }

  function panelHtml(){
    var theme = localStorage.getItem('fm-theme') || 'auto';
    var font = localStorage.getItem('fm-font') || 'normal';
    function opt(group, val, label, cur){
      return '<button data-g="'+group+'" data-v="'+val+'" style="font-size:12px; padding:5px 11px; border-radius:99px; cursor:pointer;' +
        'border:1px solid '+(val===cur?'var(--accent)':'var(--line)')+'; color:'+(val===cur?'var(--accent)':'var(--ink-2)')+';' +
        'background:transparent; font-weight:'+(val===cur?'700':'400')+';">'+label+'</button>';
    }
    return '<div style="font-size:11px; font-weight:700; color:var(--ink-3); margin-bottom:6px;">表示テーマ</div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;">' +
        opt('fm-theme','auto','自動',theme) + opt('fm-theme','light','ライト',theme) +
        opt('fm-theme','dark','ダーク',theme) + opt('fm-theme','paper','紙',theme) + '</div>' +
      '<div style="font-size:11px; font-weight:700; color:var(--ink-3); margin-bottom:6px;">文字サイズ</div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
        opt('fm-font','normal','標準',font) + opt('fm-font','large','大きめ',font) + opt('fm-font','xlarge','特大',font) + '</div>' +
      '<div style="font-size:10.5px; color:var(--ink-3); margin-top:10px; line-height:1.5;">※見た目だけの設定です。表示される事実・立場・並び順はどのテーマでも同じです（中立の条件）。</div>';
  }

  function init(){
    apply();
    var btn = document.createElement('button');
    btn.id = 'fmSettingsBtn';
    btn.setAttribute('aria-label', '表示設定');
    btn.innerHTML = '<span aria-hidden="true">⚙</span>';
    btn.style.cssText = 'position:fixed; right:14px; bottom:14px; z-index:99; width:40px; height:40px; border-radius:50%;' +
      'border:1px solid var(--line); background:var(--bg-2); color:var(--ink-2); font-size:18px; cursor:pointer; box-shadow:0 1px 6px rgba(0,0,0,.12);';
    var panel = document.createElement('div');
    panel.id = 'fmSettingsPanel';
    panel.style.cssText = 'position:fixed; right:14px; bottom:62px; z-index:99; display:none; width:230px;' +
      'background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:13px 14px; box-shadow:0 4px 18px rgba(0,0,0,.15);';
    panel.innerHTML = panelHtml();
    panel.addEventListener('click', function(ev){
      var b = ev.target.closest('button[data-g]');
      if(!b) return;
      localStorage.setItem(b.getAttribute('data-g'), b.getAttribute('data-v'));
      apply();
      panel.innerHTML = panelHtml();
    });
    btn.addEventListener('click', function(){ panel.style.display = (panel.style.display === 'none') ? 'block' : 'none'; });
    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
