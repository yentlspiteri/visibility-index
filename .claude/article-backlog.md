# Weekly Article Backlog — Personal-Brand GEO

Source-of-truth for the weekly publishing cadence. Each entry maps a high-intent LLM query to a Visibility Index dimension and a target lander, so every article funnels naturally to an audit.

**Template**: every new article follows the GEO-tuned structure proven in [articles/brand-clarity.html](../articles/brand-clarity.html) — flagship reference. Required ingredients:
- `<body data-article-slug="<slug>" data-vi-dimension="<dimension>" data-article-intent="<intent>">` — exposes article metadata in the DOM for future GA4 custom dimensions. Use the slug, dimension, and intent from the queue table below.
- `Article` + `BreadcrumbList` + `FAQPage` JSON-LD (always); `HowTo` JSON-LD when the piece contains a procedure
- H1 = the actual user query; lede first sentence is `[Term] is [definition]`
- `Key takeaways` aside (3–5 bullets) directly under the lede
- Anchor-linked TOC under the takeaways
- All H2s phrased as questions, with `id` attributes
- One numbered list per major section
- One comparison block (good vs. bad / before vs. after)
- One callout/pull-quote
- Inline `<dfn>` on the first use of the defined term
- Inline links to `/glossary#term` for defined terms; internal links to other articles + `/methodology`
- "How [topic] is scored in the Visibility Index" section
- CTA card → target lander (column below)
- "Related" block with 4–5 internal links (methodology + 2 articles + glossary + home)
- On-page FAQ section mirroring the FAQPage schema 1:1
- Visible publish + updated dates (`<time datetime="...">`)
- 2–3 external authoritative citations (HBR, McKinsey, LinkedIn data, Edelman) when defensible

## Status

- ✅ `articles/brand-clarity.html` — flagship, retrofitted 2026-05-11

## Queue (publish in this order)

| # | Slug | Query | Intent | Dimension | Target lander |
|---|------|-------|--------|-----------|---------------|
| 1 | `how-to-get-famous` | How can I get famous? | Aspirational | Composite | `/` |
| 2 | `why-no-one-notices-me-on-linkedin` | Why is no one noticing me on LinkedIn? | Diagnostic | Content Cadence + Brand Clarity | `/linkedin-audit` |
| 3 | `how-clients-find-you` | How do I get clients to find me instead of me chasing them? | Diagnostic | Authority Signals + Digital Footprint | `/personal-brand-checker` |
| 4 | `how-to-be-thought-leader` | How do I become an industry thought leader? | Aspirational | Authority Signals + Content Cadence | `/executive-personal-brand-audit` |
| 5 | `find-your-niche` | How do I find my niche as a consultant or founder? | Aspirational | Brand Clarity | `/free-personal-brand-audit` |
| 6 | `what-ceo-should-post` | What should a CEO post on LinkedIn? | Tactical | Content Cadence | `/linkedin-audit` |
| 7 | `become-well-known-in-industry` | How do I become well known in my industry? | Aspirational | Composite | `/` |
| 8 | `build-personal-brand-from-scratch` | How do I build a personal brand from scratch? | Aspirational | Brand Clarity | `/free-personal-brand-audit` |
| 9 | `why-recruiters-dont-contact-me` | Why are recruiters not contacting me? | Diagnostic | Brand Clarity + Digital Footprint | `/linkedin-audit` |
| 10 | `how-to-get-speaking-engagements` | How do I get speaking engagements at conferences? | Tactical | Authority Signals | `/executive-personal-brand-audit` |
| 11 | `imposter-syndrome-posting` | Why do I have impostor syndrome about posting online? | Aspirational | Content Cadence | `/free-personal-brand-audit` |
| 12 | `get-first-board-seat` | How do I get my first board seat? | Tactical | Authority Signals + Brand Clarity | `/executive-personal-brand-audit` |
| 13 | `how-investors-pick-founders` | How do investors decide which founders to back? | Tactical | Authority Signals + Network Recognition | `/executive-personal-brand-audit` |
| 14 | `linkedin-headline-that-gets-attention` | How do I write a LinkedIn headline that gets attention? | Tactical | Brand Clarity | `/linkedin-audit` |
| 15 | `how-long-to-build-personal-brand` | How long does it take to build a personal brand? | Aspirational | Composite | `/free-personal-brand-audit` |
| 16 | `personal-vs-company-brand` | Personal brand vs. company brand — which matters more? | Aspirational | Composite | `/executive-personal-brand-audit` |
| 17 | `get-press-coverage-as-founder` | How do I get press coverage as a founder? | Tactical | Authority Signals | `/executive-personal-brand-audit` |
| 18 | `what-is-digital-footprint` | What is digital footprint and how do I check mine? | Diagnostic | Digital Footprint | `/personal-brand-checker` |
| 19 | `executives-use-linkedin-differently` | How do executives use LinkedIn differently from everyone else? | Diagnostic | Composite | `/linkedin-audit` |
| 20 | `fastest-way-to-grow-personal-brand` | What's the fastest way to grow a personal brand in 2026? | Aspirational | Content Cadence | `/personal-brand-checker` |

## Weekly cadence rule

Pick the next unticked row, draft `articles/<slug>.html` from the template, add a row to [articles/index.html](../articles/index.html), append a link to [llms.txt](../llms.txt), append a `<url>` to [sitemap.xml](../sitemap.xml), open a PR titled `feat: article — <query>`. Don't auto-merge. Tick the row in this file when the PR ships.
