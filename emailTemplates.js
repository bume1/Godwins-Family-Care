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
  email:   config.ORG_SUPPORT_EMAIL,
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

// Invoices sign off as the finance lead and point at the finance inbox (owner,
// 2026-11-27). `email` replaces the support address in the signature, the
// text half and the footer of that email only; every other notice is unchanged.
const FINANCE_SIGNOFF = Object.freeze({
  name:  'Kelvin Ume, BSN, RN',
  title: null,
  email: config.ORG_FINANCE_EMAIL
});

const contactEmail = (signoff) => (signoff && signoff.email) || ORG.email;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Formatted bodies (announcements, 2026-11-15) ───────────────────────────
// An announcement is written in the same editor as a clinical note, so its
// body is the six-shape markup of public/note-format.js. That module gives a
// NEUTRAL tree; the HTML is produced here, because this file is the only one
// allowed to contain email markup — the same split the signed-note PDF uses
// when it draws the same tree with pdfkit.
//
// Email needs inline styles: a bare <ul> or <h3> inherits nothing from a
// stylesheet no mail client loads, and Outlook in particular mangles a list
// with no explicit margin and padding.
//
// The escaping guarantee is UNCHANGED. Text lives only in text nodes and each
// one goes through `esc` before any tag is wrapped around it, so nothing a
// person typed can become live markup. A tag this function does not know is
// rendered as its children alone, never emitted.
const noteFormat = require('./public/note-format.js');

const MARKUP_TAG_STYLE = Object.freeze({
  h3: `font-family:Georgia,serif;font-size:16px;font-weight:700;color:${PALETTE.navy};margin:22px 0 8px 0;`,
  ul: 'margin:0 0 16px 0;padding-left:22px;',
  ol: 'margin:0 0 16px 0;padding-left:22px;',
  li: 'margin:0 0 6px 0;',
  div: 'margin:0 0 12px 0;'
});

function treeToEmailHtml(nodes) {
  return (nodes || []).map((n) => {
    if (n.text !== undefined) return esc(n.text);
    if (n.tag === 'br') return '<br>';
    if (n.tag === 'a') {
      const href = safeUrl(n.href);
      const inner = treeToEmailHtml(n.children || []);
      return href ? `<a href="${esc(href)}" style="color:${PALETTE.navy};">${inner}</a>` : inner;
    }
    const inner = treeToEmailHtml(n.children || []);
    if (MARKUP_TAG_STYLE[n.tag]) return `<${n.tag} style="${MARKUP_TAG_STYLE[n.tag]}">${inner}</${n.tag}>`;
    // The inline shapes need no styling of their own; anything else is not a
    // tag this renderer emits, so only its text survives.
    if (['strong', 'em', 'u', 's', 'span'].includes(n.tag)) return `<${n.tag}>${inner}</${n.tag}>`;
    return inner;
  }).join('');
}

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
<a href="mailto:${esc(contactEmail(s))}" style="color:${PALETTE.navy};">${esc(contactEmail(s))}</a><br>
<a href="${ORG.site}" style="color:${PALETTE.navy};">godwinsfamilycarellc.com</a>
</p>
<p style="margin:18px 0 0 0;">
<img src="${ASSETS.signatureLogo}" alt="${esc(ORG.name)}" width="160" style="display:block;max-width:160px;height:auto;border:0;" />
</p>`;
}

function footerBlock(unsubscribeUrl, email) {
  const unsub = safeUrl(unsubscribeUrl)
    ? `<p style="font-size:11px;color:${PALETTE.muted};margin:8px 0 0;"><a href="${safeUrl(unsubscribeUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">Unsubscribe from these emails</a></p>`
    : '';
  return `<tr><td style="padding:24px 40px;text-align:center;">
<p style="font-size:11px;color:${PALETTE.muted};margin:0;line-height:1.6;">
${esc(ORG.name)} &nbsp;&middot;&nbsp; ${esc(ORG.phone)} &nbsp;&middot;&nbsp; ${esc(email || ORG.email)}<br>
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
//
// THE LABEL IS NOT DECORATION. In HTML the cream panel and the gold rule set
// this text apart on their own; in the TEXT half there is no panel, so an
// unlabelled reason arrived as a bare paragraph reading as though it had
// wandered in from somewhere else — "The photo is too blurry to read the expiry
// date." with nothing saying what it answers. A caller that has a reason names
// what the reason is FOR, and the name renders in both halves.
function calloutBlock(text, label) {
  if (!text) return '';
  const heading = label
    ? `<p style="margin:0 0 6px 0;font-family:Georgia,serif;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${PALETTE.navy};opacity:0.72;">${esc(label)}</p>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr>
<td style="padding:18px 22px;background:${PALETTE.cream};border-left:4px solid ${PALETTE.gold};">
${heading}<p style="margin:0;font-family:Georgia,serif;font-size:15px;color:${PALETTE.navy};line-height:1.6;">${esc(text)}</p>
</td></tr></table>`;
}

// A label/value block for the one or two emails that must carry structured
// detail rather than prose — today only the welcome email's sign-in
// credentials. It borrows the callout's cream panel and gold rule so it reads
// as part of the same system; the marketing engine has no counterpart because
// a sales email never had anything to tabulate.
function fieldsBlock(fields) {
  const rows = (Array.isArray(fields) ? fields : []).filter(f => f && f.label && f.value);
  if (!rows.length) return '';
  const cells = rows.map(f => `<tr>
<td style="padding:5px 18px 5px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${PALETTE.muted};white-space:nowrap;vertical-align:top;">${esc(f.label)}</td>
<td style="padding:5px 0;font-size:14px;color:${PALETTE.navy};font-weight:bold;word-break:break-all;${f.mono ? "font-family:'Courier New',Courier,monospace;letter-spacing:.04em;" : 'font-family:Arial,Helvetica,sans-serif;'}">${esc(f.value)}</td>
</tr>`).join('\n');
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr>
<td style="padding:16px 22px;background:${PALETTE.cream};border-left:4px solid ${PALETTE.gold};">
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${cells}</table>
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

  // Two opt-in readings (office announcements, 2026-11-10): `lineBreaks`
  // keeps a paragraph's own line breaks, and `capsHeadings` draws a short
  // line written in capitals ("WHAT'S COMING") as a heading. Escaped first,
  // always: a line break becomes <br> only after the text is safe.
  const isHeading = (p) => o.capsHeadings && !/\n/.test(p) && p.length <= 60 && /[A-Z]/.test(p) && p === p.toUpperCase();
  // `markup`: the body was written in the formatted editor, so it carries the
  // six shapes and brings its own structure — headings, lists and line breaks
  // are IN the markup, which is why it needs neither of the two flags above.
  // Opt-in and nothing else changes: a body without it renders exactly as it
  // did, because a plain announcement may contain `_` or `- ` that must stay
  // literal.
  const bodyHtml = paragraphs
    .map(p => (o.markup
      ? treeToEmailHtml(noteFormat.renderTree(p))
      : (isHeading(p)
        ? `<h2 style="font-family:Georgia,serif;font-size:17px;color:${PALETTE.navy};margin:28px 0 10px 0;letter-spacing:.02em;">${esc(p)}</h2>`
        : `<p style="margin:0 0 20px 0;">${o.lineBreaks ? esc(p).replace(/\n/g, '<br>') : esc(p)}</p>`)))
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
${fieldsBlock(o.fields)}
${calloutBlock(o.callout, o.calloutLabel)}
${ctaButton(o.ctaUrl, o.ctaLabel)}
${signatureBlock(o.signoff)}
</div></td></tr>
${footerBlock(o.unsubscribeUrl, contactEmail(o.signoff))}
</table></td></tr></table>
</body></html>`;

  const textParts = [greeting.replace(/&#39;/g, "'"), ''];
  // The text half of a formatted body goes through the same converter that
  // writes a note into OpenEMR: a heading in capitals, `• ` for a bullet,
  // `1. ` for a numbered item, and the emphasis markers dropped. A notice
  // that arrives as raw `**asterisks**` is a notice nobody reads.
  paragraphs.forEach(p => { textParts.push(o.markup ? noteFormat.toPlainText(p) : p, ''); });
  const fieldRows = (Array.isArray(o.fields) ? o.fields : []).filter(f => f && f.label && f.value);
  if (fieldRows.length) {
    fieldRows.forEach(f => textParts.push(`${f.label}: ${f.value}`));
    textParts.push('');
  }
  if (o.callout) textParts.push(o.calloutLabel ? `${o.calloutLabel}: ${o.callout}` : o.callout, '');
  if (safeUrl(o.ctaUrl)) textParts.push(`${o.ctaLabel || 'Open your portal'}: ${safeUrl(o.ctaUrl)}`, '');
  textParts.push(
    'Warmly,',
    (o.signoff || TEAM_SIGNOFF).name,
    ORG.name,
    `O: ${ORG.phone}`,
    contactEmail(o.signoff)
  );
  if (safeUrl(o.unsubscribeUrl)) {
    textParts.push('', `Unsubscribe: ${safeUrl(o.unsubscribeUrl)}`);
  }

  return { html, text: textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

module.exports = {
  renderGfcEmail,
  headerBlock, signatureBlock, footerBlock, ctaButton, calloutBlock, fieldsBlock,
  PALETTE, ASSETS, ORG, TEAM_SIGNOFF, FINANCE_SIGNOFF,
  // exported for tests
  esc, safeUrl
};
