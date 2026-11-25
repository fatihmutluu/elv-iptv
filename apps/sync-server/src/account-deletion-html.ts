/** Security headers attached to the public `/account-deletion` HTML page. */
export const ACCOUNT_DELETION_HTML_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

/** Renders the accessible bilingual (EN/TR) public account-deletion page for store compliance. */
export function renderAccountDeletionHtml(submitted = false): string {
  const confirmationBanner = submitted
    ? `<section class="banner" role="status" aria-live="polite">
        <p><strong>Request received / Talebiniz alındı:</strong> If an ELV IPTV sync account is associated with the address provided, deletion instructions apply immediately. For instant zero-knowledge erasure, open ELV IPTV and go to <strong>Settings &rarr; Account &rarr; Delete Account</strong> (<em>Ayarlar &rarr; Hesap &rarr; Hesabı Kalıcı Olarak Sil</em>).</p>
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ELV IPTV — Account Deletion / Hesap Silme</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      padding: 2rem 1rem 3rem;
      background: #0b0e14;
      color: #e6ebf5;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      line-height: 1.55;
    }
    main { max-width: 46rem; margin: 0 auto; }
    h1 { font-size: 1.75rem; margin: 0 0 0.5rem; }
    h2 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; color: #9ec5ff; }
    p, li { color: #c7d1e3; }
    .card {
      background: #141925;
      border: 1px solid #263046;
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      margin-top: 1.25rem;
    }
    .banner {
      background: #132a20;
      border: 1px solid #2c6e4f;
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin: 1rem 0;
    }
    label { display: block; font-weight: 600; margin-top: 0.9rem; margin-bottom: 0.35rem; }
    input, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 0.65rem 0.75rem;
      border-radius: 8px;
      border: 1px solid #354463;
      background: #0d111a;
      color: #f3f6fc;
      font: inherit;
    }
    button {
      margin-top: 1rem;
      padding: 0.7rem 1.25rem;
      border: none;
      border-radius: 8px;
      background: #c93b3b;
      color: #ffffff;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #b12e2e; }
    .note { font-size: 0.9rem; color: #98a6c0; }
  </style>
</head>
<body>
  <main>
    <h1>ELV IPTV — Permanent Account Deletion</h1>
    <p class="note">Türkçe açıklamalar aşağıda yer almaktadır. / English and Turkish instructions are provided below.</p>
    ${confirmationBanner}
    <section class="card">
      <h2>Instant In-App Deletion (Recommended)</h2>
      <ol>
        <li>Open <strong>ELV IPTV</strong> on any signed-in device.</li>
        <li>Navigate to <strong>Settings &rarr; Account &rarr; Delete Account</strong>.</li>
        <li>Re-enter your password and select <strong>Confirm Permanent Deletion</strong>.</li>
      </ol>
      <p>This calls <code>DELETE /v1/auth/account</code> and immediately erases your account record, encrypted sync vault, active refresh sessions, and any pending pairing sessions from the server. Local playlists stored on your device are not deleted.</p>
    </section>

    <section class="card" lang="tr">
      <h2>Uygulama İçinden Anında Silme (Önerilen)</h2>
      <ol>
        <li>Oturum açtığınız herhangi bir cihazda <strong>ELV IPTV</strong> uygulamasını açın.</li>
        <li><strong>Ayarlar &rarr; Hesap &rarr; Hesabı Kalıcı Olarak Sil</strong> bölümüne gidin.</li>
        <li>Şifrenizi tekrar girip <strong>Kalıcı Silmeyi Onayla</strong> seçeneğini onaylayın.</li>
      </ol>
      <p>Bu işlem hesabınızı, şifreli eşitleme kasanızı, aktif oturumlarınızı ve bekleyen eşleştirme kayıtlarınızı sunucudan kalıcı olarak siler. Cihazınızdaki yerel listeleriniz korunur.</p>
    </section>

    <section class="card">
      <h2>Web Deletion Request / Web Üzerinden Silme Talebi</h2>
      <p>If you no longer have the app installed, submit your account email below. For privacy protection, this form never confirms whether an account exists for a given address.</p>
      <form method="post" action="/account-deletion">
        <label for="email">Account Email / Hesap E-posta Adresi</label>
        <input id="email" name="email" type="email" required autocomplete="email" maxlength="254" placeholder="you@example.com" />
        <label for="note">Confirmation Note (Optional) / Onay Notu (İsteğe Bağlı)</label>
        <textarea id="note" name="note" rows="3" maxlength="500" placeholder="Please permanently delete my ELV IPTV sync account."></textarea>
        <button type="submit">Submit Account Deletion Request / Silme Talebi Gönder</button>
      </form>
      <p class="note">ELV IPTV sync accounts are end-to-end encrypted; the server never has access to your playlist URLs, provider credentials, or viewing history.</p>
    </section>
  </main>
</body>
</html>
`;
}
