# GFC Design Directions — Web & App Alignment

## Decision
Use **all three** v2 directions, with **Literary (v1)** and **Warm-Modern (v2)** as the current primary. **Clinical-Document (v3)** is reserved for reference-heavy pages.

## The live site is the public source of truth
`godwinsfamilycarellc.com` is shipped and what families already recognize — match it. Its signature:
- Serif (Cormorant Garamond) display headlines with **one italic emphasis word** ("Care that *notices* what others miss," "Clinical oversight, *in every visit*").
- Letterspaced all-caps eyebrows ("WHO WE ARE," "OUR SERVICES").
- Numbered sections (01–06) and checkmark (✓) feature lists.
- Photo-forward warmth; navy / gold / cream; founder-forward credibility.
- Services framed as Track A / Track B / Add-On / Specialty.

## Direction → where each is used
| Direction | Character | Use for |
|---|---|---|
| **v1 Literary** | Serif-led, gold-on-navy editorial, italic-emphasis headlines | Marketing and brand pages, storytelling, hero sections. **Primary.** |
| **v2 Warm-Modern** | Photo-forward, rounded, sans-primary with serif accents | The app (client, family, caregiver) and warmer marketing pages. **Primary.** |
| **v3 Clinical-Document** | Numbered sections, ruled tables, newspaper reference | Reference/dense pages: IME & referral-partner, policies, clinical documents. As needed. |

## The app
The app carries the site's brand DNA in **Warm-Modern's register**:
- Serif headings, with an occasional italic emphasis word on **client/family-facing** screens.
- Letterspaced eyebrows, numbered steps, checkmark lists, navy / gold / cream.
- **Minor app variations:** type smaller than marketing but with a 16px floor; denser spacing; sans for all UI and body; photography used sparingly (onboarding, empty states), never full-bleed heroes.
- **Caregiver work screens stay utilitarian** — the editorial italic device is for client, family, and marketing, not dense work forms.

## Tokens
All three directions share `colors_and_type.css`. Gold `#C9A44A` for buttons and links, `#F5CD85` as the pale highlight/badge gold, white on navy never grey. Cormorant Garamond for headings, DM Sans for body and UI.
