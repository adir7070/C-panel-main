/**
 * Section Blueprint — archetype library + brief-aware planner.
 *
 * Replaces the "adapt this reference template" approach. The reference is used
 * only for visual DNA (fonts + palette); structure is planned explicitly here
 * so different generations of the same brief/style can have different layouts.
 */

const SECTION_ARCHETYPES = [
  {
    id: 'hero',
    mandatory: true,
    variants: [
      { id: 'hero-full-bleed', spec: 'Full 100vh hero. Background image 1920x1080 with sophisticated gradient overlay (40-60% opacity, brand colors). Center-aligned: bold headline 80-120px with CSS gradient text or letter-spacing drama, paragraph, TWO CTAs (primary solid + secondary ghost), scroll indicator (animated chevron), trust row of 3 stats.' },
      { id: 'hero-split-editorial', spec: 'Full 100vh hero split 50/50. Large image on ONE side (in RTL: left visually), text block on other side with oversized serif headline (animated letter-stagger), paragraph, single prominent CTA. Magazine-style, generous whitespace, small vertical label/kicker above headline.' },
      { id: 'hero-asymmetric-glass', spec: 'Full 100vh hero. Background image covers whole viewport. A frosted-glass / glassmorphism panel is offset from center (e.g. bottom-left or right-third) containing headline + short paragraph + CTA. Dramatic diagonal gradient behind glass. Looks unbalanced but intentional.' },
      { id: 'hero-oversized-type', spec: 'Full 100vh hero with NO image — the typography IS the design. Colossal headline 140-200px breaking viewport edges, using mix-blend-mode or kinetic stroke animation. Small paragraph + inline CTA. Brand color as background. Minimal, bold, loud.' },
      { id: 'hero-grid-showcase', spec: 'Hero with split: 40% text column (headline + paragraph + CTA), 60% asymmetric grid of 3-4 image tiles of varying sizes (bento-style). Images represent the business visually. 100vh total height.' },
    ],
  },
  {
    id: 'about',
    mandatory: true,
    variants: [
      { id: 'about-split-image', spec: 'Split 50/50 (or 45/55) section. Image column with real <img> tag (min-height 500px, object-fit cover). Text column with small kicker label, h2 headline, 2-3 paragraph body, "read more" CTA button. Stacks on mobile.' },
      { id: 'about-manifesto', spec: 'Full-width text-centric section. Pull-quote style giant paragraph (40-60px font) with 1-2 emphasized words in accent color. No image or subtle background texture. Feels like a magazine opener.' },
      { id: 'about-timeline', spec: 'About section built as a horizontal or vertical timeline showing 3-4 milestones (founding year, key moments). Each milestone: year label, headline, short description. Small decorative line connecting items.' },
      { id: 'about-stats-overlay', spec: 'About section where 3-4 big stats (number + label) are overlaid on a rich-text paragraph area. Stats are visually dominant (80px+ numbers in accent color). Paragraph flows around or behind them.' },
    ],
  },
  {
    id: 'services',
    mandatory: true,
    variants: [
      { id: 'services-grid-3', spec: 'Services displayed as a 3-column grid (2 on tablet, 1 on mobile). Each card: icon or small image, service name (h3), 2-line description, optional "learn more" link. Equal card heights. Hover: lift shadow or border highlight.' },
      { id: 'services-feature-rows', spec: 'Each service gets its own full-width alternating row (image-left / image-right / image-left…). Large image 600x400, text column with service name, description, bullet points, CTA. Rich editorial feel.' },
      { id: 'services-tabs', spec: 'Tab navigation at top listing all services. Clicking a tab (or scrolling via hash links) shows a detail panel with image + description + features list. Pre-select first tab. Smooth animated transitions.' },
      { id: 'services-bento', spec: 'Asymmetric bento-style grid: services sized differently based on importance. Featured service takes 2x width or height tile. Mix of text-only, image-only, and image+text cards. Sharp clean grid-gap.' },
    ],
  },
  {
    id: 'gallery',
    includeIf: (b) => (b.photos?.length || 0) >= 1,
    variants: [
      { id: 'gallery-masonry', spec: 'Masonry layout (Pinterest style) with images of varying heights. 3 columns on desktop, 2 on tablet, 1 on mobile. Subtle hover zoom. 8-12 images total.' },
      { id: 'gallery-grid-uniform', spec: 'Uniform grid 3x3 or 4x3 of square/portrait images. Equal gap. Hover: color overlay with title or subtle zoom.' },
      { id: 'gallery-carousel-peek', spec: 'Horizontal scrolling carousel with partial-peek of next image. Images aspect 4:3 or 3:4. Scroll-snap for mobile feel. Navigation arrows on desktop.' },
      { id: 'gallery-full-bleed-strip', spec: 'Edge-to-edge horizontal strip of 5-7 images covering full viewport width. Images tall and narrow (portrait 3:4). Slow auto-scroll or static based on variant.' },
    ],
  },
  {
    id: 'testimonials',
    mandatory: true,
    variants: [
      { id: 'testimonials-carousel', spec: '7+ testimonials in a horizontal swipe carousel. Each card: client photo (round, 60px), name, role, 3+ line quote, 5-star rating. Navigation dots. Smooth scroll-snap.' },
      { id: 'testimonials-wall', spec: 'Masonry-style wall of 7+ quote cards in varying sizes. Mix of small square cards (name + short quote) and larger rectangles (longer quote + photo). Quotation mark accent.' },
      { id: 'testimonials-featured-quote', spec: 'One huge featured testimonial: large photo of client + massive pull-quote (40px+) + name/role. Below: small strip of 4-5 compact testimonials as supporting proof.' },
      { id: 'testimonials-video-trio', spec: '3 testimonial cards styled like video thumbnails (with play-button icon overlay). Each has client photo, name, role, short quote, mock duration tag. No actual video needed — placeholders.' },
    ],
  },
  {
    id: 'promotion',
    includeIf: (b) => !!b.promotion && b.promotion.trim().length > 0,
    variants: [
      { id: 'promo-banner-strip', spec: 'Full-width promotional banner with strong background color (use accent color). Centered big text: promo title + description + prominent CTA button. Often placed right after hero.' },
      { id: 'promo-split-card', spec: 'Promotional section split 50/50. One side: vivid image representing the offer. Other side: bold headline of offer, explanation paragraph, prominent CTA. Card elevation feel.' },
      { id: 'promo-countdown', spec: 'Time-limited offer styling with prominent countdown-style layout (days/hours/minutes in boxes). Strong urgency design — contrast colors, bold CTA. Even if no real timer, visual style.' },
    ],
  },
  {
    id: 'faq',
    includeIf: (b) => (b.faq?.length || 0) >= 1,
    variants: [
      { id: 'faq-accordion', spec: 'Standard expandable accordion. Questions as clickable rows, clicking expands the answer with smooth animation. Plus/minus icon toggle. First item pre-expanded.' },
      { id: 'faq-grid-cards', spec: '2-column grid of Q&A cards. Each card: question as h3, answer as paragraph below. No expand/collapse — everything visible at once.' },
      { id: 'faq-chat-style', spec: 'FAQ styled as a chat conversation. Questions on one side (user bubble), answers on the other side (business bubble). Avatars + timestamps for flavor.' },
    ],
  },
  {
    id: 'team',
    variants: [
      { id: 'team-grid', spec: 'Team section: 3-6 portrait cards in a grid. Each card: portrait photo (portrait 3:4), name, role, optional 1-line bio, social links row.' },
      { id: 'team-single-founder', spec: 'Founder spotlight: large portrait on one side, rich bio on the other. Quote pull-out, signature line, social icons.' },
    ],
  },
  {
    id: 'stats',
    variants: [
      { id: 'stats-horizontal-row', spec: 'Row of 4 big statistics. Each: large number (80px+ in accent color), small label below. Horizontal equal-width cells. Subtle dividers between.' },
      { id: 'stats-with-icons', spec: 'Stats with accompanying illustrations or icons. 2x2 grid (mobile) or 1x4 row (desktop). Each: icon + number + label + 1-line context.' },
    ],
  },
  {
    id: 'process',
    variants: [
      { id: 'process-timeline-vertical', spec: '4-5 step process as vertical timeline. Connecting vertical line down center. Each step: number badge (circle), title, description, optional small illustration.' },
      { id: 'process-numbered-cards', spec: '3-5 process cards in a horizontal row. Each card dominated by big number 01/02/03 in accent color, step title, short description. Equal height.' },
      { id: 'process-horizontal-scroll', spec: 'Horizontal scrolling process with arrows between steps. Each step an image + title + description. Connector arrows/dots between. Auto-advance or manual scroll.' },
    ],
  },
  {
    id: 'location',
    includeIf: (b) => !!b.address && b.address.trim().length > 3,
    variants: [
      { id: 'location-map-split', spec: 'Split 50/50: embedded static map image (placeholder with map-style styling) on one side, contact details on other (address, hours, phone, WhatsApp, social icons). Clear heading.' },
      { id: 'location-minimal-block', spec: 'Minimal contact block. No map. Address + hours + phone as a clean business-card-style centered block with generous whitespace. Optional subtle background tint.' },
    ],
  },
  {
    id: 'cta',
    mandatory: true,
    variants: [
      { id: 'cta-banner-full', spec: 'Full-width CTA banner. Strong background (accent color or gradient). Centered: big headline, short persuasive line, oversized primary button. Often precedes footer.' },
      { id: 'cta-split-image', spec: 'CTA section split 50/50. Image on one side (evocative photo). Other side: bold headline, 1-2 line copy, prominent button. Card elevation.' },
      { id: 'cta-floating-card', spec: 'Floating glassmorphism/elevated card centered on a background color or texture. Card contains: icon/label kicker, headline, paragraph, CTA. Looks like an invitation.' },
    ],
  },
];

// Deterministic PRNG — sessionId hash → reproducible per-session randomness
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function planSections(brief, seedKey = String(Date.now())) {
  const rnd = mulberry32(seedFromString(seedKey));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  // Step 1 — determine which archetypes to include.
  const plan = [];
  const mandatory = SECTION_ARCHETYPES.filter(a => a.mandatory);
  const conditional = SECTION_ARCHETYPES.filter(a => !a.mandatory && a.includeIf && a.includeIf(brief));
  const optional = SECTION_ARCHETYPES.filter(a => !a.mandatory && !a.includeIf);

  for (const a of mandatory) plan.push(a);
  for (const a of conditional) plan.push(a);

  // Add 1-2 optional archetypes for flavor (weighted random).
  const optionalCount = 1 + Math.floor(rnd() * 2); // 1 or 2
  const shuffledOptional = [...optional].sort(() => rnd() - 0.5);
  for (const a of shuffledOptional.slice(0, optionalCount)) plan.push(a);

  // Step 2 — determine the order. Opinionated narrative flow, with some shuffle freedom.
  //   hero → promotion? → about → services → gallery? → stats/process/team → testimonials → faq? → location? → cta
  const ORDER_WEIGHTS = {
    hero: 0, promotion: 1, about: 2, services: 3, gallery: 4,
    stats: 5, process: 5.1, team: 5.2,
    testimonials: 6, faq: 7, location: 8, cta: 9,
  };
  plan.sort((a, b) => (ORDER_WEIGHTS[a.id] ?? 5) - (ORDER_WEIGHTS[b.id] ?? 5));

  // Step 3 — pick a variant per archetype.
  return plan.map(a => {
    const variant = pick(a.variants);
    return {
      archetype: a.id,
      variant: variant.id,
      spec: variant.spec,
      rationale: a.mandatory ? 'mandatory' : (a.includeIf ? 'triggered by brief' : 'random variety'),
    };
  });
}

function renderBlueprint(plan) {
  const lines = plan.map((s, i) => {
    const num = String(i + 1).padStart(2, '0');
    return `### Section ${num} — ${s.archetype.toUpperCase()} (variant: ${s.variant})
${s.spec}`;
  });
  return `SECTION BLUEPRINT — build EXACTLY these sections in this order. Do NOT add, remove, or reorder sections. Each section must faithfully implement its variant spec.

${lines.join('\n\n')}`;
}

module.exports = {
  SECTION_ARCHETYPES,
  planSections,
  renderBlueprint,
};
