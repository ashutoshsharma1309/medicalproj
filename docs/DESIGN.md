# Meridian — Design System

## Direction

Meridian's interface is modeled on the artifacts clinicians already trust: the paper hospital
chart, the monitoring strip, the allergy wristband. The look is **calm clinical paper with deep
surgical-green ink** — no gradients, no glassmorphism, no "AI" glitter. AI output is presented
the way a lab result is: labelled with its engine, bounded by reference context, awaiting
clinician judgment.

Anti-goals: purple AI gradients, floating sparkle icons, dark cyberpunk panels, decorative
animation.

## Typography

| Role | Face | Why |
|---|---|---|
| UI / body | IBM Plex Sans | Institutional, neutral, excellent at 13–14 px data density |
| Identifiers & measurements | IBM Plex Mono (tabular numerals) | MRNs, doses, lab values and timestamps read as *data*, not prose |
| Display (login only) | Source Serif 4 | A single humanist-serif moment for the brand statement |

Eyebrow labels (`--font-mono`, 10.5 px, +12% tracking, uppercase) carry the chart-tab hierarchy
throughout the product.

## Color

| Token | Value | Use |
|---|---|---|
| `paper` | `#F6F7F6` | App background — cool clinical off-white |
| `surface` | `#FFFFFF` | Cards |
| `ink` | `#1C2B27` | Primary text — green-black, softer than pure black |
| `muted` / `faint` | `#5C6B66` / `#8B9793` | Secondary text |
| `hairline` | `#DDE3E0` | 1 px rules everywhere — the chart grid |
| `scrub` | `#16594A` | Primary actions, active states — surgical-scrub green |
| `rail` | `#12241F` | Navigation rail — the "dark chart room" |
| `critical / warn / ok / info` | `#B42318 / #B54708 / #067647 / #175CD3` | **Clinical semantics only** — severity, flags, alerts. Never decorative. |

Reserving the signal palette exclusively for clinical meaning is the core accessibility and
trust decision: if something is red, it is a patient-safety fact.

## Signature elements

1. **Allergy wristband** — the patient header carries a diagonally-striped red band
   (`.allergy-band`), a direct quote of the physical allergy wristband. Repeated in the patient
   portal so the same fact has the same shape for both audiences.
2. **Timeline spine** — a hairline vertical spine with category-colored dots, grouped by year
   in a monospace gutter; reads like a chart flowsheet.
3. **"Why" bars** — every AI/rule score is displayed with its factor decomposition as quiet
   green weight bars + evidence lines. Explainability is a layout primitive, not a tooltip.
4. **Engine provenance line** — every generated artifact ends with a mono uppercase footer:
   `ENGINE: RULES-V1 · DECISION SUPPORT — CLINICIAN REVIEW REQUIRED`.

## Components

Buttons (primary/secondary/ghost), fields, tables (mono uppercase headers, hover wash),
severity chips (`chip-critical|high|medium|low` — bordered, mono, uppercase), stat blocks,
section cards with eyebrow+title headers, sparklines with reference-range banding (SVG,
server-rendered), factor bars, empty states, the dark nav rail.

## Interaction principles

- Motion is limited to 120 ms color/border transitions; `prefers-reduced-motion` disables all.
- Buttons state their outcome ("Score & add to queue", "Approve & finalize"), never "Submit".
- Errors say what happened and what to do; empty states say what will appear and how to cause it.
- AI never auto-applies: extraction is filed, notes are drafted as DRAFT, risk is advisory.
