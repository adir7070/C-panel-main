---
name: clone-website
description: Use when the user asks to clone, copy, recreate, or rebuild an existing live website in plain HTML/CSS/JS (often as a static replica or migration off a CMS like WordPress/Elementor/Wix). Triggers include phrases like "copy this site", "תעתיק את האתר", "recreate this in HTML", "rebuild this page", "make me the same site". Skip for greenfield designs where the user has no reference URL.
---

# Clone Website Skill

Goal: produce a static HTML/CSS/JS replica that visually and structurally matches a live reference URL — pixel-close, not a generic re-imagining.

## The trap to avoid

WebFetch returns a *summary* of the page, not the source. If you build from the summary alone you'll invent your own design (wrong colors, wrong layout, wrong assets) and the client will reject it. **Always pull the raw HTML and inspect it before writing a single line of markup.**

## Required workflow

### 1. Pull raw source

```powershell
Invoke-WebRequest -Uri "<URL>" -OutFile "c:\tmp\site.html" -UseBasicParsing
```

(or `curl -sL <URL> -o site.html` on bash). Then operate on the local file with Grep/Read.

### 2. Extract the real assets — never invent them

Run regex extractions against the raw HTML to harvest the *actual* URLs and tokens. Don't guess any of these:

- **All image URLs** (jpg/png/svg/webp). WordPress/Elementor sites lazy-load — look in `data-lazy-src`, `data-src`, `<source srcset>`, and `<noscript>` tags, not just `<img src>`.
- **All hex/rgb colors** — the dominant brand color hides among hundreds. Sort by frequency or scan the inline `<style>` blocks.
- **Fonts** — search `font-family:`, `fonts.googleapis.com`, and known Hebrew font names (Heebo, Assistant, Rubik, Ploni, FbReforma).
- **Headings & paragraphs** — `grep -oE '<h[1-6][^>]*>[^<]+</h[1-6]>'` and `<p>...</p>` to get exact copy in the original language.
- **Menu items / nav structure** — usually inside `<ul class="menu">` or `nav`.

PowerShell pattern that survives long lines (Grep tool truncates):
```powershell
$html = Get-Content -LiteralPath "c:\tmp\site.html" -Raw -Encoding UTF8
[regex]::Matches($html, 'https://[^"\s]+\.(?:jpg|png|svg|webp)') | % { $_.Value } | Sort -Unique
[regex]::Matches($html, '#[A-Fa-f0-9]{6}|rgba?\([0-9, .]+\)')   | % { $_.Value } | Sort -Unique
```

### 3. Cross-reference with screenshots

If the user attached screenshots, use them to disambiguate the layout the HTML alone won't reveal:
- Which color is the brand color vs. one-off accent
- Section ordering and visual hierarchy
- Card vs. carousel vs. grid choices
- Font weights and heading sizes

Don't pick a "modern" alternative layout that diverges from the original. The client wants *their* site, not your reinterpretation.

### 4. Decide on asset strategy

Two valid approaches — ask if unclear:
- **Hot-link to the original CDN URLs** — fastest, identical look, but breaks when the original goes down. Good for prototypes.
- **Download images locally** — needed if the client is migrating off the original host or wants a self-contained deliverable. Use `Invoke-WebRequest` in a loop, save under `assets/images/` with safe filenames (URL-decoded Hebrew filenames break on some servers — slugify them).

Default to local download for production work; hot-link for quick prototypes.

### 5. Build with the actual tokens

- Set CSS variables to the exact extracted hex values (e.g. `--brand: #ffb4a2`).
- Use the exact Google Font found in the source.
- Match RTL/LTR direction from the original `<html dir>`.
- Replicate copy verbatim — do not paraphrase Hebrew text. Even small wording changes feel "off" to a native client.

### 6. Match structure section-by-section

For each section in the original, build the same structure: same number of items, same icons, same image positions, same CTA placement. Upgrades the user requests are *additive* (animations, mobile polish, perf) — they should not change the visible layout.

### 7. Verify before declaring done

- Open the file in a browser and compare side-by-side against the screenshot.
- Check responsive breakpoints — the original probably has a tablet and mobile layout you need to mirror.
- Verify Hebrew text renders correctly (charset utf-8, dir="rtl", Hebrew-friendly font).

## Common mistakes to avoid

1. **Building from the WebFetch summary instead of raw HTML** — produces a generic-looking site that doesn't match.
2. **Inventing colors** — "looks pinkish" is not a color. Pull the hex.
3. **Using Unsplash placeholder images** when the real assets are accessible — instant tell that it's a fake.
4. **Reordering or merging sections** — the client memorized the original order.
5. **Switching fonts to your favorite** — match the original.
6. **Skipping the topbar / utility nav** — small bars at the top of WordPress sites are easy to miss in summaries but very visible to the client.
7. **Replacing native form submissions with `console.log`** without flagging it — note explicitly that the form needs a backend wired up.

## Output checklist

- [ ] Raw HTML downloaded and inspected
- [ ] All image URLs extracted (lazy + noscript)
- [ ] Brand colors extracted as hex
- [ ] Font family identified
- [ ] All headings and key copy extracted verbatim
- [ ] Section list matches original 1:1
- [ ] Screenshots compared
- [ ] Asset strategy chosen (local vs. hot-link) and applied
- [ ] RTL/dir matches original
- [ ] Form submission stub clearly marked TODO
