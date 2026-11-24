/** Supported UI locales for the LAN pairing mobile web form. */
export type LanPairingLocale = 'en' | 'tr';

/** Options for rendering the self-contained LAN pairing HTML page. */
export interface RenderLanPairingHtmlOptions {
  readonly token: string;
  readonly locale?: LanPairingLocale;
}

interface PairingCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly tabM3u: string;
  readonly tabXtream: string;
  readonly labelM3uUrl: string;
  readonly labelServer: string;
  readonly labelUsername: string;
  readonly labelPassword: string;
  readonly labelName: string;
  readonly labelGuideUrl: string;
  readonly placeholderM3uUrl: string;
  readonly placeholderServer: string;
  readonly placeholderName: string;
  readonly placeholderGuideUrl: string;
  readonly submit: string;
  readonly sending: string;
  readonly sentTitle: string;
  readonly sentBody: string;
  readonly errUrlScheme: string;
  readonly errGuideScheme: string;
  readonly errCredentials: string;
  readonly errNetwork: string;
  readonly errServer: string;
  readonly privacyNote: string;
}

const COPY: Readonly<Record<LanPairingLocale, PairingCopy>> = {
  en: {
    title: 'Send Source to TV',
    subtitle: 'Enter your playlist details to send them directly over your local Wi-Fi.',
    tabM3u: 'M3U URL',
    tabXtream: 'Xtream Codes',
    labelM3uUrl: 'Playlist URL',
    labelServer: 'Server URL',
    labelUsername: 'Username',
    labelPassword: 'Password',
    labelName: 'Source name (optional)',
    labelGuideUrl: 'EPG / Guide URL (optional)',
    placeholderM3uUrl: 'https://example.com/playlist.m3u',
    placeholderServer: 'https://provider.example:8080',
    placeholderName: 'Living Room TV',
    placeholderGuideUrl: 'https://example.com/epg.xml.gz',
    submit: 'Send to TV',
    sending: 'Sending…',
    sentTitle: 'Sent to your TV',
    sentBody: 'Your source was delivered over your local network. You can close this page.',
    errUrlScheme: 'Enter a valid http:// or https:// URL.',
    errGuideScheme: 'EPG URL must start with http:// or https://.',
    errCredentials: 'Enter server URL, username, and password.',
    errNetwork: 'Could not reach your TV. Check Wi-Fi or generate a new QR code.',
    errServer: 'The TV could not accept this request. Generate a new QR code and try again.',
    privacyNote: 'Stays strictly on your local network. Link expires automatically.',
  },
  tr: {
    title: 'TV’ye Kaynak Gönder',
    subtitle: 'Oynatma listesi bilgilerinizi yerel Wi-Fi üzerinden doğrudan TV’ye gönderin.',
    tabM3u: 'M3U Bağlantısı',
    tabXtream: 'Xtream Codes',
    labelM3uUrl: 'Oynatma Listesi URL',
    labelServer: 'Sunucu URL',
    labelUsername: 'Kullanıcı Adı',
    labelPassword: 'Parola',
    labelName: 'Kaynak adı (isteğe bağlı)',
    labelGuideUrl: 'EPG / Rehber URL (isteğe bağlı)',
    placeholderM3uUrl: 'https://example.com/playlist.m3u',
    placeholderServer: 'https://provider.example:8080',
    placeholderName: 'Oturma Odası TV',
    placeholderGuideUrl: 'https://example.com/epg.xml.gz',
    submit: 'TV’ye Gönder',
    sending: 'Gönderiliyor…',
    sentTitle: 'TV’ye Gönderildi',
    sentBody: 'Kaynağınız yerel ağ üzerinden iletildi. Bu sayfayı kapatabilirsiniz.',
    errUrlScheme: 'Geçerli bir http:// veya https:// adresi girin.',
    errGuideScheme: 'EPG adresi http:// veya https:// ile başlamalıdır.',
    errCredentials: 'Sunucu adresi, kullanıcı adı ve parolayı girin.',
    errNetwork: 'TV’ye ulaşılamadı. Wi-Fi bağlantısını kontrol edin veya yeni QR kod oluşturun.',
    errServer: 'TV bu isteği kabul edemedi. Yeni bir QR kod oluşturup tekrar deneyin.',
    privacyNote: 'Yalnızca yerel ağınızda kalır. Bağlantı otomatik olarak sona erer.',
  },
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Renders the self-contained, mobile-responsive dark-mode HTML form for phone-to-TV LAN pairing (`#50`).
 * Makes zero external requests and never relies on `window.crypto.subtle` so it works over plain LAN HTTP.
 */
export function renderLanPairingHtml(opts: RenderLanPairingHtmlOptions): string {
  const locale: LanPairingLocale = opts.locale === 'tr' ? 'tr' : 'en';
  const c = COPY[locale];
  const encodedToken = encodeURIComponent(opts.token);
  const actionPath = `/pair/${encodedToken}`;

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(c.title)}</title>
<style>
:root{color-scheme:dark;--bg:#0b0d12;--card:#141821;--border:#262d3d;--text:#eef2f8;--muted:#98a4b8;--accent:#e5a93c;--accent-fg:#111318;--err:#f87171;--ok:#4ade80;--input:#0f131b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px 40px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px 20px}
h1{margin:0 0 6px;font-size:22px;font-weight:700;letter-spacing:-0.01em}
.sub{margin:0 0 18px;font-size:14px;line-height:1.45;color:var(--muted)}
.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px;background:var(--input);padding:4px;border-radius:12px;border:1px solid var(--border)}
.tab{min-height:44px;border:0;border-radius:9px;background:transparent;color:var(--muted);font-size:14px;font-weight:600;cursor:pointer}
.tab[aria-selected="true"]{background:var(--accent);color:var(--accent-fg)}
.field{margin-bottom:14px}
label{display:block;margin-bottom:6px;font-size:13px;font-weight:600;color:var(--text)}
input{width:100%;min-height:46px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--input);color:var(--text);font-size:16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.hidden{display:none}
.btn{width:100%;min-height:48px;margin-top:6px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);font-size:16px;font-weight:700;cursor:pointer}
.btn:disabled{opacity:.6;cursor:default}
.msg{margin-top:14px;padding:12px 14px;border-radius:10px;font-size:14px;line-height:1.4}
.msg.err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.35);color:var(--err)}
.msg.ok{background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.35);color:var(--ok)}
.note{margin:16px 0 0;font-size:12px;line-height:1.4;color:var(--muted);text-align:center}
</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(c.title)}</h1>
  <p class="sub">${escapeHtml(c.subtitle)}</p>
  <div id="formWrap">
    <div class="tabs" role="tablist">
      <button type="button" class="tab" id="tabM3u" role="tab" aria-selected="true">${escapeHtml(c.tabM3u)}</button>
      <button type="button" class="tab" id="tabXtream" role="tab" aria-selected="false">${escapeHtml(c.tabXtream)}</button>
    </div>
    <form id="pairForm" method="post" action="${escapeHtml(actionPath)}" novalidate>
      <input type="hidden" id="kind" name="kind" value="m3u">
      <div id="m3uFields">
        <div class="field">
          <label for="m3uUrl">${escapeHtml(c.labelM3uUrl)}</label>
          <input id="m3uUrl" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(c.placeholderM3uUrl)}">
        </div>
      </div>
      <div id="xtreamFields" class="hidden">
        <div class="field">
          <label for="server">${escapeHtml(c.labelServer)}</label>
          <input id="server" name="server" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(c.placeholderServer)}">
        </div>
        <div class="field">
          <label for="username">${escapeHtml(c.labelUsername)}</label>
          <input id="username" name="username" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="password">${escapeHtml(c.labelPassword)}</label>
          <input id="password" name="password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
      </div>
      <div class="field">
        <label for="name">${escapeHtml(c.labelName)}</label>
        <input id="name" name="name" type="text" maxlength="120" autocomplete="off" placeholder="${escapeHtml(c.placeholderName)}">
      </div>
      <div class="field">
        <label for="guideUrl">${escapeHtml(c.labelGuideUrl)}</label>
        <input id="guideUrl" name="guideUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${escapeHtml(c.placeholderGuideUrl)}">
      </div>
      <button type="submit" id="submitBtn" class="btn">${escapeHtml(c.submit)}</button>
      <div id="errorBox" class="msg err hidden" role="alert"></div>
    </form>
  </div>
  <div id="successBox" class="msg ok hidden" role="status">
    <strong>${escapeHtml(c.sentTitle)}</strong><br>${escapeHtml(c.sentBody)}
  </div>
  <p class="note">${escapeHtml(c.privacyNote)}</p>
</main>
<script>
(function(){
  var ENDPOINT="${escapeJsString(actionPath)}";
  var MSG={
    submit:"${escapeJsString(c.submit)}",
    sending:"${escapeJsString(c.sending)}",
    errUrl:"${escapeJsString(c.errUrlScheme)}",
    errGuide:"${escapeJsString(c.errGuideScheme)}",
    errCreds:"${escapeJsString(c.errCredentials)}",
    errNet:"${escapeJsString(c.errNetwork)}",
    errSrv:"${escapeJsString(c.errServer)}"
  };
  var mode="m3u";
  var tabM3u=document.getElementById("tabM3u");
  var tabXtream=document.getElementById("tabXtream");
  var m3uFields=document.getElementById("m3uFields");
  var xtreamFields=document.getElementById("xtreamFields");
  var kindInput=document.getElementById("kind");
  var form=document.getElementById("pairForm");
  var submitBtn=document.getElementById("submitBtn");
  var errorBox=document.getElementById("errorBox");
  var formWrap=document.getElementById("formWrap");
  var successBox=document.getElementById("successBox");
  function isHttpUrl(v){return /^https?:\\/\\/[^\\s]+$/i.test(v);}
  function showError(msg){errorBox.textContent=msg;errorBox.classList.remove("hidden");}
  function clearError(){errorBox.textContent="";errorBox.classList.add("hidden");}
  function setMode(next){
    mode=next;kindInput.value=next;clearError();
    var isM3u=next==="m3u";
    tabM3u.setAttribute("aria-selected",isM3u?"true":"false");
    tabXtream.setAttribute("aria-selected",isM3u?"false":"true");
    m3uFields.classList.toggle("hidden",!isM3u);
    xtreamFields.classList.toggle("hidden",isM3u);
  }
  tabM3u.addEventListener("click",function(){setMode("m3u");});
  tabXtream.addEventListener("click",function(){setMode("xtream");});
  form.addEventListener("submit",function(ev){
    ev.preventDefault();clearError();
    var name=document.getElementById("name").value.trim();
    var guideUrl=document.getElementById("guideUrl").value.trim();
    if(guideUrl&&!isHttpUrl(guideUrl)){showError(MSG.errGuide);return;}
    var payload;
    if(mode==="m3u"){
      var url=document.getElementById("m3uUrl").value.trim();
      if(!isHttpUrl(url)){showError(MSG.errUrl);return;}
      payload={kind:"m3u",name:name,url:url};
    }else{
      var server=document.getElementById("server").value.trim();
      var username=document.getElementById("username").value.trim();
      var password=document.getElementById("password").value.trim();
      if(!server||!username||!password){showError(MSG.errCreds);return;}
      if(!isHttpUrl(server)){showError(MSG.errUrl);return;}
      payload={kind:"xtream",name:name,server:server,username:username,password:password};
    }
    if(guideUrl){payload.guideUrl=guideUrl;}
    submitBtn.disabled=true;submitBtn.textContent=MSG.sending;
    fetch(ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
      .then(function(res){
        if(res.ok){formWrap.classList.add("hidden");successBox.classList.remove("hidden");return;}
        submitBtn.disabled=false;submitBtn.textContent=MSG.submit;showError(MSG.errSrv);
      })
      .catch(function(){
        submitBtn.disabled=false;submitBtn.textContent=MSG.submit;showError(MSG.errNet);
      });
  });
})();
</script>
</body>
</html>`;
}
