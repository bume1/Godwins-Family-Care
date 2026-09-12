// ============================================================================
// GFC TRANSACTIONAL EMAIL TEMPLATE
// ============================================================================
// One house style for every email the app sends, ported from the layout the
// marketing sequence engine already uses: navy header bar with the wordmark,
// gold rule, white card on cream, Georgia headline, signature block, address
// footer. A client who gets an outreach email and then a portal notification
// should not be able to tell they came from two different systems.
//
// THREE THINGS THIS DELIBERATELY DOES NOT PORT FROM THE MARKETING ENGINE:
//
//   1. The open-tracking pixel. The marketing engine tracks opens on purpose;
//      a transactional email to a patient is a different thing entirely, and a
//      tracking beacon on it records that a specific person read a message
//      about their care. Build-enforced absent.
//   2. UTM campaign parameters. A link in a care notification is not a
//      campaign, and tagging it as one puts patient traffic into marketing
//      analytics.
//   3. Marketing copy — brochures, service tables, testimonials. A notice that
//      a document was rejected is not an opportunity to sell.
//
// Every render returns BOTH html and text. The Gmail transport builds a
// multipart/alternative message from the pair, so a text-only client sees a
// real message rather than stripped markup.
// ============================================================================

const config = require('./config');

// The marketing engine's palette, kept literal so the two systems cannot drift
// apart silently. config.BRAND supplies the values it already knows.
const PALETTE = Object.freeze({
  navy:   config.BRAND.PRIMARY_COLOR,   // #033D50
  gold:   config.BRAND.ACCENT_COLOR,    // #F5CD85
  cream:  '#FAF7F2',
  rule:   '#EDE7DF',
  body:   '#3a4a52',
  muted:  '#8a9aa2',
  white:  '#ffffff'
});

// Hosted on the public marketing site, which is where the sequence engine
// already points. An email client cannot reach an asset behind the app's auth,
// so a locally served logo would render as a broken image.
const ASSETS = Object.freeze({
  headerLogo:    'https://godwinsfamilycarellc.com/wp-content/uploads/2024/10/Godwins-llc-3.png',
  signatureLogo: 'https://godwinsfamilycarellc.com/wp-content/uploads/2026/05/logo-full-color-transparent.png'
});

const ORG = Object.freeze({
  name:    'Godwins Family Care LLC',
  short:   config.BRAND.COMPANY_NAME,
  address: '4300 Paces Ferry Road SE, Suite 500, Atlanta, GA 30339',
  phone:   '(404) 913-6705',
  email:   'admin@godwinsfamilycarellc.com',
  site:    'https://godwinsfamilycarellc.com'
});

// An automated notice signs off as the practice, not as a person. The
// marketing engine signs as Bianca because she wrote those emails; nobody
// personally wrote "your document was received", and attributing it to a named
// clinician would be a small lie repeated thousands of times.
const TEAM_SIGNOFF = Object.freeze({
  name:  'The Godwins Family Care Team',
  title: null
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// A URL that will be placed in an href. Anything that is not plainly http(s)
// is dropped rather than rendered, so a stored value cannot become a
// javascript: link in someone's inbox.
const safeUrl = (u) => {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
};

// ---- Blocks, matching the marketing engine's shared blocks -----------------

function headerBlock() {
  return `<tr><td style="background:${PALETTE.navy};padding:28px 40px;border-radius:8px 8px 0 0;">
<img src="${ASSETS.headerLogo}" alt="${esc(ORG.short)}" height="44" style="display:block;border:0;" />
</td></tr><tr><td style="background:${PALETTE.gold};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
}

function signatureBlock(signoff) {
  const s = signoff || TEAM_SIGNOFF;
  const titleLine = s.title ? `${esc(s.title)}<br>` : '';
  return `<p style="margin:28px 0 0 0;">Warmly,</p>
<p style="margin:18px 0 0 0;">
<strong>${esc(s.name)}</strong><br>
${titleLine}${esc(ORG.name)}<br>
O: ${esc(ORG.phone)}<br>
<a href="mailto:${esc(ORG.email)}" style="color:${PALETTE.navy};">${esc(ORG.email)}</a><br>
<a href="${ORG.site}" style="color:${PALETTE.navy};">godwinsfamilycarellc.com</a>
</p>
<p style="margin:18px 0 0 0;">
<img src="${ASSETS.signatureLogo}" alt="${esc(ORG.name)}" width="160" style="display:block;max-width:160px;height:auto;border:0;" />
</p>`;
}

function footerBlock(unsubscribeUrl) {
  const unsub = safeUrl(unsubscribeUrl)
    ? `<p style="font-size:11px;color:${PALETTE.muted};margin:8px 0 0;"><a href="${safeUrl(unsubscribeUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">Unsubscribe from these emails</a></p>`
    : '';
  return `<tr><td style="padding:24px 40px;text-align:center;">
<p style="font-size:11px;color:${PALETTE.muted};margin:0;line-height:1.6;">
${esc(ORG.name)} &nbsp;&middot;&nbsp; ${esc(ORG.phone)} &nbsp;&middot;&nbsp; ${esc(ORG.email)}<br>
${esc(ORG.address)}
</p>${unsub}</td></tr>`;
}

function ctaButton(url, label) {
  const u = safeUrl(url);
  if (!u || !label) return '';
  return `<p style="margin:4px 0 8px 0;"><a href="${u}" style="display:inline-block;background:${PALETTE.navy};color:${PALETTE.gold};font-weight:bold;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:6px;font-family:Arial,Helvetica,sans-serif;">${esc(label)}</a></p>`;
}

// The cream callout with the gold left rule — the marketing engine uses it for
// testimonials; here it carries the one thing the reader must not miss, such
// as why a document came back.
function calloutBlock(text) {
  if (!text) return '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr>
<td style="padding:18px 22px;background:${PALETTE.cream};border-left:4px solid ${PALETTE.gold};">
<p style="margin:0;font-family:Georgia,serif;font-size:15px;color:${PALETTE.navy};line-height:1.6;">${esc(text)}</p>
</td></tr></table>`;
}

/**
 * Render one transactional email in the GFC house style.
 *
 * Returns { html, text }. Both are always produced: the mailer sends them as
 * multipart/alternative, and a notification that renders as raw markup in a
 * text-only client is a notification nobody reads.
 */
function renderGfcEmail(opts) {
  const o = opts || {};
  const greeting = o.greeting ? `Hi ${esc(o.greeting)},` : 'Hello,';
  const paragraphs = (Array.isArray(o.paragraphs) ? o.paragraphs : []).filter(Boolean);
  const headline = o.headline
    ? `<h1 style="font-family:Georgia,serif;font-size:22px;color:${PALETTE.navy};margin:0 0 24px 0;">${esc(o.headline)}</h1>`
    : '';

  const bodyHtml = paragraphs
    .map(p => `<p style="margin:0 0 20px 0;">${esc(p)}</p>`)
    .join('\n');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${PALETTE.cream};font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.cream};"><tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
${headerBlock()}
<tr><td style="background:${PALETTE.white};padding:40px;border-radius:0 0 8px 8px;">
${headline}
<div style="font-size:14px;color:${PALETTE.body};line-height:1.75;">
<p style="margin:0 0 16px 0;">${greeting}</p>
${bodyHtml}
${calloutBlock(o.callout)}
${ctaButton(o.ctaUrl, o.ctaLabel)}
${signatureBlock(o.signoff)}
</div></td></tr>
${footerBlock(o.unsubscribeUrl)}
</table></td></tr></table>
</body></html>`;

  const textParts = [greeting.replace(/&#39;/g, "'"), ''];
  paragraphs.forEach(p => { textParts.push(p, ''); });
  if (o.callout) textParts.push(o.callout, '');
  if (safeUrl(o.ctaUrl)) textParts.push(`${o.ctaLabel || 'Open your portal'}: ${safeUrl(o.ctaUrl)}`, '');
  textParts.push(
    'Warmly,',
    (o.signoff || TEAM_SIGNOFF).name,
    ORG.name,
    `O: ${ORG.phone}`,
    ORG.email
  );
  if (safeUrl(o.unsubscribeUrl)) {
    textParts.push('', `Unsubscribe: ${safeUrl(o.unsubscribeUrl)}`);
  }

  return { html, text: textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

module.exports = {
  renderGfcEmail,
  headerBlock, signatureBlock, footerBlock, ctaButton, calloutBlock,
  PALETTE, ASSETS, ORG, TEAM_SIGNOFF,
  // exported for tests
  esc, safeUrl
};
