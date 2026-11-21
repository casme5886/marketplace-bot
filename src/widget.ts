/**
 * Telegram Bot API 10.4 — xabar ichidagi interaktiv vidjet (sendWidget).
 * HTML o'zgarmaydi, faqat chat_data (JSON) yangilanadi.
 * Cheklovlar: siqilgan HTML <= 4 KB, input/fetch yo'q, faqat tugmalar.
 */
export const ORDER_WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{font:14px system-ui,sans-serif;color:var(--tg-theme-text-color,#111);background:var(--tg-theme-bg-color,#fff);padding:12px}
.h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.b{font-weight:700;font-size:15px}
.mp{padding:2px 8px;border-radius:10px;color:#fff;font-size:12px;font-weight:600}
.ozon{background:#005bff}.wb{background:#cb11ab}
.n{color:var(--tg-theme-hint-color,#888);font-size:12px;margin-bottom:8px}
.it{padding:6px 0;border-top:1px solid rgba(128,128,128,.2)}
.r{display:flex;justify-content:space-between;padding:3px 0}
.r span:first-child{color:var(--tg-theme-hint-color,#888)}
.dl{margin-top:6px;padding:6px 8px;border-radius:8px;background:rgba(255,149,0,.15);font-weight:600}
.st{margin-top:6px;font-weight:600}
.x{margin-top:6px;font-size:12px;color:var(--tg-theme-hint-color,#888)}
.bt{display:flex;gap:8px;margin-top:10px}
button{flex:1;border:0;border-radius:10px;padding:10px;font-size:14px;font-weight:600;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff)}
button.s{background:var(--tg-theme-secondary-bg-color,#eee);color:var(--tg-theme-text-color,#111)}
button:disabled{opacity:.5}
</style></head><body><div id="a"></div><script>
var W=window.TelegramWidget,busy=0;
function e(s){return String(s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function g(){try{return JSON.parse(W.chatData||'{}')}catch(_){return{}}}
function q(cmd){if(busy)return;busy=1;r(1);var p=W.request(cmd);if(p&&p.then){p.then(function(){busy=0;r()},function(){busy=0;r()})}else{busy=0}}
function r(w){var d=g(),h='';
h+='<div class="h"><span class="b">'+(d.sh?'🆕 Yangi buyurtma':'📦 Buyurtma')+'</span><span class="mp '+e(d.k||'')+'">'+e(d.m||'')+'</span></div>';
h+='<div class="n">№ '+e(d.n||'')+'</div>';
(d.i||[]).forEach(function(x){h+='<div class="it">'+e(x[0])+' <b>× '+e(x[1])+'</b></div>'});
h+='<div class="r"><span>Narx</span><b>'+e(d.p||'')+'</b></div>';
h+='<div class="r"><span>Qayerga</span><b>'+e(d.c||'')+'</b></div>';
h+='<div class="r"><span>Qabul</span><span>'+e(d.t||'')+'</span></div>';
if(d.d)h+='<div class="dl">⏰ Topshirish: '+e(d.d)+' gacha</div>';
h+='<div class="st">📌 '+e(d.s||'')+'</div>';
if(d.x)h+='<div class="x">'+e(d.x)+'</div>';
h+='<div class="bt">';
if(d.sh)h+='<button id="s"'+(w?' disabled':'')+'>✅ Yig\\'ishga olish</button>';
h+='<button class="s" id="l"'+(w?' disabled':'')+'>🏷 Yorliq</button></div>';
document.getElementById('a').innerHTML=h;
var s=document.getElementById('s');if(s)s.onclick=function(){q('ship')};
document.getElementById('l').onclick=function(){q('label')};}
if(W){W.onEvent('chatDataChanged',function(){r()});r();W.ready&&W.ready()}
</script></body></html>`;
