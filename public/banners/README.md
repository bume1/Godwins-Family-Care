# Banner Images

Brand photography from `docs/design-system/assets/` (Session 3.5 — the legacy
lab photos are removed). Warm, care-appropriate imagery per the design-system
README: photography full-bleed sparingly, navy gradient overlay for legibility.

| Filename | Source asset | Used In |
|----------|--------------|---------|
| `banner-admin.webp` | `team-bethel.webp` (founder portrait) | Admin Hub Dashboard, Portal Hub |
| `banner-client.jpg` | `photo-couple-walking.jpg` | Client Portal admin dashboard |
| `banner-service.jpg` | `photo-couple-walking.jpg` | Service Portal Dashboard |
| `banner-caregiver.jpg` | `photo-couple-walking.jpg` **(placeholder)** | Caregiver welcome packet hero |

**`banner-caregiver.jpg` is a placeholder.** It is a copy of the client
banner so the packet is never a broken image; the intended photo is a
caregiver with a client. Drop the real one in at that exact filename —
nothing in the code changes.

## Recommended Specifications

- **Dimensions**: 1920x600px (or similar 3:1 aspect ratio) preferred; any
  aspect works — banners render with `background-size: cover`, center crop
- **Format**: JPG, WebP, or PNG
- **File size**: Under 500KB preferred for optimal loading
