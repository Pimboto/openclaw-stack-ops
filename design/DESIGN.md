# DESIGN.md — Ascii Magic

> Design-system spec reverse-engineered from the landing page screenshot.
> Hex values, sizes and font names are **best-guess approximations** read off a static
> capture — treat them as a starting point and calibrate against the live site / Figma.

---

## 1. Design philosophy

A **dark terminal / retro-tech** aesthetic where the product premise *is* the hero.
The whole page is built around one idea: feed in a normal photo, get ASCII art out. So the
hero isn't a headline with a stock image — it's a live **before/after** of the
transformation, and the style row underneath lets you preview every rendering mode.

Three principles drive every choice:

- **Monospace everything.** It's a tool about characters, so the type is the brand. Code
  vocabulary leaks into the copy (`{Disco Art}` in curly braces, like a template variable).
- **Near-black canvas, let the artwork glow.** The UI recedes to a single dark surface so
  the cyan + warm-cream ASCII render is the only thing with color and light.
- **Quiet chrome, sharp utility.** Nav, buttons and pills are hairline-bordered, low-contrast,
  transparent-filled. Nothing competes with the hero.

---

## 2. Design tokens

### 2.1 Color

| Token | Hex (approx) | Role / usage |
|---|---|---|
| `--bg` | `#0A0A0B` | Page + nav background (near-black, very slightly cool) |
| `--surface` | `#161618` | Lifted surface — active pill, hovered controls |
| `--fg` | `#F2F2F0` | Primary text, logo wordmark, active labels |
| `--fg-muted` | `#9A9A9C` | Inactive nav links + inactive pill labels |
| `--border` | `#2A2A2C` | Default hairline border (inactive pills, dividers) |
| `--border-strong` | `#6E6E72` | Button borders + active pill border |
| `--accent-amber` | `#E8A84C` | Logo sparkle ✦ (the one warm UI accent) |
| `--accent-cyan` | `#5BB8E0` | Brand secondary, pulled from the ASCII render (links/focus) |
| `--accent-cream` | `#E6D6B0` | Warm highlight, also from the render |

**Artwork palette** (informational — the hero image, not UI):
deep navy `#0A1420` → mid sky `#26517E` → cyan chars `#4F9FD4` / `#7FCBE8` →
warm cloud `#E6D6B0` / `#F0E6CE`, with a faint amber bloom `#C9885A` at the horizon and a
dark maroon glow `#2E1A12` top-left.

> Palette intent: a **single dark surface**, **one warm UI accent** (the amber sparkle), and
> **cyan/cream borrowed straight from the output** so the brand color literally comes from the
> product. Avoid adding a third UI accent — it breaks the discipline.

### 2.2 Typography

This is the personality of the page — get it right and 80% of the look is there.

| Role | Face | Notes |
|---|---|---|
| **Display** (the big headline) | **Bold monospace** | Even-width, sturdy, smooth (not pixelated). Closest free matches: **Space Mono**, **JetBrains Mono**, **Martian Mono**, **Geist Mono** — all Bold/700. Pick one and commit. |
| **UI / nav / buttons / pills** | Same mono @ 400–500, *or* a neutral grotesque | For max cohesion keep the same monospace at regular weight. If you want a touch more legibility in nav/body, pair with **Geist Sans** / **Inter** and keep mono only for the display + data. |

**Type scale** (desktop, approx):

| Element | Size | Weight | Tracking / leading |
|---|---|---|---|
| Display headline | `60–72px` (`clamp(2.5rem, 5vw, 4.5rem)`) | 700 | leading `1.05`, tracking `-0.01em` |
| Nav links | `15px` | 400 | leading `1`, normal tracking |
| Button label | `14px` | 500 | normal |
| Pill label | `13–14px` | 400 (500 when active) | normal |
| "After" / overlay label | `13px` | 400 | normal, `--fg` |

### 2.3 Spacing & layout

- **Base unit:** `4px`. Common steps: `8 / 12 / 16 / 24 / 32 / 48 / 64`.
- **Page container:** centered, `max-width ≈ 1440px`, horizontal padding `~32–48px`.
- **Hero:** near-full-bleed — sits a touch wider than the text container, with a thin
  `~12–16px` gutter on each side. Sharp corners (no radius on the hero itself).
- **Nav height:** `~64px`.
- **Vertical rhythm:** hero → pills row (inside hero, bottom-left) → `~48px` gap → display block.

### 2.4 Radius, borders, elevation

- **Border radius:** `4–6px` on buttons and pills (rounded rectangles, *not* full pills).
  Slider handle is a full circle.
- **Borders:** hairline `1px`. Inactive uses `--border`; buttons + active pill use `--border-strong`.
- **Elevation:** essentially flat. "Depth" comes from the `--surface` fill on active/hover,
  not from shadows. Optional soft glow only on the artwork, never on chrome.

---

## 3. Layout structure

```
┌──────────────────────────────────────────────────────────────────────┐
│  ✦ Ascii Magic    Usecases  Styles  FAQ  Tools▾  Blog  Changelog   [Open tool] │  ← nav, 64px
├──────────────────────────────────────────────────────────────────────┤
│                                                            After       │
│                                                                        │
│ ❯  ░░░░░░░░░░░ ASCII before/after artwork (hero) ░░░░░░░░░░░░░░░░░░░    │  ← hero ~560px
│ │←slider handle                                                        │
│                                                                        │
│  [Characters][Block Chars][Pixel Art][Mosaic][LEGO][Disco][Animated…][Dots][Cross][•••] │ ← pills
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Turn your images                                   [Open ASCII Magic] │  ← display block
│  and videos into {Disco Art}                                           │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

Left edges of the **logo**, the **pill row** and the **display headline** align to the same
x. The hero bleeds slightly past that to the left/right.

---

## 4. Component specs

### 4.1 Navigation bar
- Layout: `flex`, `justify-between`, `align-center`, full width, `64px` tall, `--bg`.
- **Left:** amber sparkle `✦` (`--accent-amber`) + wordmark "Ascii Magic" in `--fg`, mono.
- **Center:** link group, `gap ~28px`, color `--fg-muted`, hover → `--fg`. "Tools" has a `▾` caret (dropdown).
- **Right:** `Open tool` outlined button.
- Likely sticky/transparent over the hero on scroll.

### 4.2 Buttons (outlined CTA)
Two instances, same recipe at two sizes:

```
border: 1px solid var(--border-strong);
border-radius: 5px;
background: transparent;
color: var(--fg);
font: 500 14px / 1 <mono>;
padding: 8px 14px;        /* nav "Open tool" */
padding: 12px 20px;       /* section "Open ASCII Magic" — larger */
```
Hover: `background: rgba(255,255,255,0.06)` and/or `border-color: var(--fg)`.

### 4.3 Before/After comparison slider (the hero)
- Two stacked images (original underneath, ASCII render on top) clipped by a draggable vertical divider.
- **Handle:** circular, `~36px`, dark fill `--surface`, hairline border, contains a chevron `❯`. Sits on the divider line, vertically centered. Draggable left↔right (and likely keyboard-accessible).
- **Corner label:** "After" top-right (`--fg`, 13px). The hidden side would read "Before".
- The render shows ASCII glyphs colored by the underlying pixels — cyan in the sky, cream in the clouds.

### 4.4 Style selector (pill / segmented row)
- Horizontal row, left-aligned at the bottom of the hero, `gap ~8–10px`.
- Each pill: rounded rect `radius 5px`, `padding ~10px 16px`, hairline border, mono label.
  - **Inactive:** `border: var(--border)`, `color: var(--fg-muted)`, transparent bg.
  - **Active** (`Characters` in the shot): `border: var(--border-strong)`, `color: var(--fg)`, `background: var(--surface)`, label weight 500.
- Items: `Characters · Block Chars · Pixel Art · Mosaic · LEGO · Disco · Animated ASCII · Dots · Cross` + a `•••` overflow pill.
- Selecting a pill re-renders the hero in that style. Behaves like a single-select segmented control.

### 4.5 Display headline + rotating brace-text
- Bold monospace, `clamp(2.5rem, 5vw, 4.5rem)`, leading `~1.05`, color `--fg`.
- Copy: `Turn your images and videos into {Disco Art}`.
- The `{ }` braces are a **signature device**: the word inside almost certainly cycles
  (`{Disco Art}` → `{Pixel Art}` → `{ASCII Art}` …) on an interval, echoing a template
  variable. Keep the braces literal and `--fg`; you can tint the cycling word with
  `--accent-cyan` for emphasis.

---

## 5. Motion & interaction
- **Before/after:** smooth drag on the divider; consider snap-to-edge and arrow-key control.
- **Brace word swap:** timed crossfade/cycle (~2–3s per word). Respect `prefers-reduced-motion` → hold one word.
- **Hover micro-interactions:** nav links and buttons fade `--fg-muted → --fg` (~150ms ease).
- **Pill switch:** instant active-state change + hero re-render (ideally with a quick fade between styles).
- Keep motion **sparse** — the artwork carries the energy; over-animating the chrome cheapens it.

---

## 6. Implementation notes (Next.js + Tailwind)

**Source of truth = CSS variables** (works as-is for Tailwind v4 `@theme`, and as fallbacks for v3).

```css
/* globals.css */
:root {
  --bg: #0A0A0B;
  --surface: #161618;
  --fg: #F2F2F0;
  --fg-muted: #9A9A9C;
  --border: #2A2A2C;
  --border-strong: #6E6E72;
  --accent-amber: #E8A84C;
  --accent-cyan: #5BB8E0;
  --accent-cream: #E6D6B0;

  --radius: 5px;
  --nav-h: 64px;
  --container: 1440px;
}
body { background: var(--bg); color: var(--fg); }
```

**Fonts** — load via `next/font` (zero layout shift):

```ts
// app/fonts.ts
import { Space_Mono } from "next/font/google";
export const mono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
});
// swap Space_Mono for JetBrains_Mono / a self-hosted Martian Mono if you prefer
```

**Tailwind v3 token extension** (skip if on v4 — use `@theme` with the vars above):

```js
// tailwind.config.js → theme.extend
colors: {
  bg: "var(--bg)",
  surface: "var(--surface)",
  fg: { DEFAULT: "var(--fg)", muted: "var(--fg-muted)" },
  border: { DEFAULT: "var(--border)", strong: "var(--border-strong)" },
  accent: { amber: "var(--accent-amber)", cyan: "var(--accent-cyan)", cream: "var(--accent-cream)" },
},
fontFamily: { mono: ["var(--font-mono)", "monospace"] },
borderRadius: { DEFAULT: "5px" },
```

**Pill component sketch:**

```tsx
function StylePill({ label, active = false, onClick }: {
  label: string; active?: boolean; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "font-mono text-[13px] px-4 py-2.5 rounded border transition-colors",
        active
          ? "border-border-strong text-fg bg-surface font-medium"
          : "border-border text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
```

**Before/after slider:** roll your own with a clipped overlay + draggable handle, or use a
lib like `react-compare-slider` and restyle the handle to the circular chevron.

---

## 7. Assets & accessibility floor
- **Logo:** amber sparkle glyph + mono wordmark. Provide an SVG sparkle; don't rely on an emoji.
- **Hero artwork:** export the ASCII render at 2x; lazy-load below-fold media.
- **Quality floor:** responsive to mobile (nav collapses to a menu, pills become a horizontal
  scroll row, headline scales down), visible keyboard focus on every control, `alt` text on
  before/after images, and `prefers-reduced-motion` honored for the brace cycle and any
  style-switch fades.

---

*Spec derived from a single static screenshot — verify exact hex, type sizes and the display
font against the production build before locking tokens.*