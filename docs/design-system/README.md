# Godwins Family Care — Design System

A working brand and UI system for **Godwins Family Care LLC (GFCLLC)** — a physician and FNP-owned healthcare organization based in North Atlanta / Cobb County, Georgia.

## About the company

Godwins Family Care operates **three service pipelines** under one trusted, clinician-owned brand:

1. **Private Home Care** — Personal care under Georgia's PHCP license. Three tiers (Essential ADL, Comprehensive Home Care, Behavioral & Cognitive Wellness). Same caregiver every visit.
2. **In-Home Medical Care** — Provider visits, Chronic Care Management (CCM), and a *Continuous Care* hybrid monitoring program (cameras + scheduled video check-ins) under Bethel Godwins, FNP.
3. **Independent Medical Examinations (IMEs)** — Federal contractor partnerships with LSGS and Leidos QTC.

**Audience:** Adult children (45–65) coordinating care for aging parents — often professionals managing care from a distance — and the seniors themselves. Designs must read clearly to elderly users and feel trustworthy to professional decision-makers.

**Voice:** Warm, direct, professional. Physician-credentialed, but lead with care — never clinical coldness, never corporate. Think *trusted family expert*, not *hospital system*.

**Service area:** North Atlanta + Cobb County (Acworth, Kennesaw, Woodstock, Marietta, Roswell, Smyrna, Powder Springs, Canton).

## Sources used to build this system

- **Brand palette + type direction** from user notes (navy/gold/cream; Cormorant Garamond + DM Sans).
- **PDF brochures** (`uploads/`): client brochure, facility brochure, referral partner instructions, CCM program one-pager, business cards. Extracted text in `extracted/`.
- **Photography** (`uploads/`): Bethel Godwins, FNP portrait; senior couple walking; in-home blood-pressure check; team portrait.
- **Logos** (`uploads/Godwins-llc-3.png`, `Godwins-llc-e1728321601816.png`).
- **GitHub repo** `bume1/Godwins-Family-Care` was reviewed but contains a different product (Thrive 365 Labs Client Portal Hub) — *not* the GFC marketing site. **No GFC web codebase was provided**, so the UI kit here is built from the brochures + brand notes, not lifted from a reference site.

## Index — what's in this project

| File / folder | What it is |
|---|---|
| `colors_and_type.css` | Brand tokens — colors, type scale, spacing, radii, motion |
| `assets/` | Logos, photography, team portraits |
| `extracted/` | Raw text extracted from the brochure PDFs |
| `preview/` | Design system cards (typography, color, components) |
| `ui_kits/website/` | Marketing site recreation (hero, services, CCM, testimonials, contact) |
| `SKILL.md` | Agent Skill manifest for downloading this system to Claude Code |

## Content fundamentals

**Tone:** Warm-professional. Clinician-credentialed but human. Says "loved one" and "your mother/father" more than "patient." Uses *we* (the agency) and *you* (the family member). Never *I*.

**Casing:** Title Case headings; SMALL CAPS or `LETTERSPACED ALL-CAPS` for eyebrow labels (e.g. `WHO WE ARE`, `OUR SERVICES`). Sentence case for body and CTAs.

**Length:** Short, declarative. Tag-line first, then a one-sentence elaboration. Lists use checkmarks (✓), not bullets, and keep items to 4–8 words.

**Signature phrases (lift from brochures verbatim where natural):**
- "Compassionate Care. Clinician-Backed. Trusted Evaluations." (tagline)
- "We notice what others miss."
- "Same caregiver, every visit."
- "Bridge the gap — your loved one doesn't need a nurse yet, but needs more than companionship."
- "Physician & FNP-owned" (always paired with the brand)

**Numbers and credentials are credibility levers** — show them: hourly rates, minimum visit lengths, "$299 flat monthly," "free 15-min introduction," "(404) 913-6705."

**No emoji.** Brochures use ✓ marks (U+2713) and small geometric numerals (`01`, `02`, `03`) for steps. That's it.

**Avoid:** "patient," "facility," "consumer," "leverage," "solutions," "journey," "empower." Avoid hospital-system jargon. Avoid hype.

## Visual foundations

**Palette.** Three colors carry the brand:
- **Navy `#033D50`** — primary dark, headlines, hero backgrounds. Always paired with **white** text. Never grey, never cream on navy.
- **Gold `#C9A44A` / `#F5CD85`** — accent. Buttons, dividers, eyebrows, the linked-hearts in the logo. Two values: a saturated gold for buttons/links and a pale gold (`#F5CD85`) for highlights and badges on cream.
- **Cream `#FAF7F2`** — page surface. Warm, never sterile-white. A second cream `#F2EBDD` lifts cards on the page.

**Type.** Cormorant Garamond (serif display) for every heading and tagline; DM Sans for body, eyebrows, buttons, and small UI. Size scale skews **larger** than typical web — body is 18px default, never below 16px; minimum on slides is 24px. Headings use `text-wrap: balance`, body uses `text-wrap: pretty`.

**Backgrounds.** Solid color most of the time — cream for content surfaces, navy for hero / section breaks. Photography is used full-bleed sparingly for emotional moments (couple walking, in-home check-up). No repeating patterns, no busy textures, no abstract gradients. A gentle gold-tint vignette over hero photography is acceptable.

**Imagery vibe.** Warm and natural — daylight, real homes (not clinical interiors), real people (not stock-model perfection). Photography skews warm; if a cool image must be used, warm it slightly with a cream overlay.

**Animation.** Restrained. 240ms `cubic-bezier(0.22, 1, 0.36, 1)` for hover/state changes; 420ms for entrance. Fades and small Y-translates only. No bounce, no spring, no parallax. Reduced-motion: respect it fully.

**Hover states.** Buttons: navy-deep `#022A38` on the navy primary; gold goes ~6% darker on the gold pill. Links: underline thickens; color shifts slightly. **Never** opacity-fades — always color shifts.

**Press states.** Small `transform: translateY(1px)` and shadow drop. No shrink/scale.

**Borders.** 1px hairlines in `--gfc-line` (`#E1D9C9`). On navy, a 1px `rgba(255,255,255,0.12)` hairline. Avoid heavy outlines.

**Shadows.** Three steps. `sm` for inputs and chips, `md` for cards on cream, `lg` for the floating contact CTA. Shadows are tinted navy (`rgba(3, 61, 80, …)`), not pure black, so they read warm.

**Corner radii.** Generous, rounded — `14px` for cards, `20px` for hero panels, fully **pill-shaped** for buttons (`999px`). The brochures and the logo's interlocking-hearts shape both lean rounded; angular corners feel wrong here.

**Cards.** Cream surface, navy hairline-shadow, 14–20px radius, generous internal padding (24–32px). Headline in navy serif, body in DM Sans. Sometimes a thin gold rule above the headline — never a colored left-border-only card (avoid that AI-slop pattern).

**Layout rules.** 1200px max content width; 880px for reading-heavy sections. Generous whitespace — never feel cramped. Two-column hero with large photography on one side; three-card grids for service tiers (24–32px gutter). Section vertical rhythm: 96–128px top/bottom on desktop. Sticky header is acceptable; floating CTAs are not.

**Transparency / blur.** Used sparingly — only on the sticky header (cream at `0.85` with `backdrop-filter: blur(10px)`) and on the hero photo overlay (a navy-to-transparent gradient at the bottom for text legibility). Never frosted-glass card effects.

**Iconography (see ICONOGRAPHY below).**

## Iconography

**Source.** Godwins Family Care has no proprietary icon set in the materials provided. The brochures rely almost entirely on **checkmarks (✓)** and **numbered step markers** — that's the native iconographic language.

**System used here.** **Lucide** (CDN) — clean, friendly, 1.75–2px stroke, rounded line caps. The slightly softer rounded terminals match the brand's curved, friendly feel (logo is built from interlocking rounded "hearts"). Loaded via:
```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.js"></script>
```
*Note: Lucide is a substitution. If the live site uses a different icon set, replace these references and let the user know.*

**Usage rules.**
- Stroke width: `1.75px` default, `2px` only when icons are 16px or smaller.
- Color: usually `--gfc-navy`; use `--gfc-gold` only for accent moments (a single feature icon, a callout).
- Size: 20px inline with text, 24px for list items, 32–40px in feature cards. Never below 16px.
- Always pair an icon with a text label — icons never stand alone.

**Brand iconographic moments:**
- ✓ checkmark (gold) — used in feature/promise lists. Encoded as text `✓`, not an SVG.
- Numbered steps `01 02 03 04 05` — large gold serif numerals for "how it works" sequences.
- The interlocking-hearts mark from the logo is the only *brand* graphic — used as a watermark or favicon, never as a generic icon.

**No emoji**, ever. **No unicode pictographs** beyond `✓`.

## Open questions / asks for the user

See bottom of this file's "caveats" section in chat — fonts and the icon set are the two main confirmations needed.
