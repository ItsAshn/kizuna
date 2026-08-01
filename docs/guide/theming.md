---
title: Theming
description: Restyle your Kizuna server with custom CSS — the full design-token reference, the rules the sandbox enforces, and a complete example theme.
---

# Theming

Every Kizuna server can carry its own look. Admins paste CSS into
**Settings → admin → custom css**, and it is applied to every member's client
when they connect to that server. Nothing is compiled, nothing is uploaded —
it is one stylesheet stored on your server and served with the rest of the
server info.

The app's entire visual language is expressed as CSS custom properties on
`:root`. Override those and the whole interface follows, without you having to
know a single component class name.

## Quick start

```css
:root {
  --brand: #ff2ec4;
  --bg-primary: #1a0b2e;
  --bg-secondary: #24123f;
  --radius-md: 20px;
}
```

Paste that into the custom CSS editor. The preview is live — the app restyles
as you type, before you save — and `save css` publishes it to everyone.

## How it is applied

Understanding the mechanics saves a lot of guessing:

- Your CSS is injected as a `<style>` element appended to the end of
  `<head>`, **after** the app's own stylesheets. Later rules of equal
  specificity win, so a plain `:root { … }` override beats the shipped one
  without `!important`.
- It is applied **per server**. Switching servers swaps the stylesheet;
  disconnecting removes it.
- It applies **inside the app only**. The landing, login, and server-browser
  screens render before you are connected to a server, so they keep the
  default look.
- Each member can turn it off locally under **Settings → user → profile →
  display → enable custom css**. Treat that as the escape hatch: a theme
  cannot lock anyone out.
- Everything is client-side. A theme cannot read messages, make network
  requests, or change what the server sends.

## The rules

| Rule         | Value              |
| ------------ | ------------------ |
| Maximum size | 50,000 characters  |
| Who can edit | Server admins only |
| `url()`      | Rejected           |
| `@import`    | Rejected           |

`url()` and `@import` are the only two ways a stylesheet can make a browser
fetch a third-party address, which would hand every member's IP and
user-agent to whoever the URL points at. Both are rejected at save time, in
any spelling — uppercase, or written with CSS escapes such as `\75 rl(`.

In practice that means **no images and no web fonts**. Gradients, shadows,
glows, borders, transforms, and animations are all fine, and so are fonts
already installed on the member's machine. Anything you cannot express without
fetching a file is out of reach; a server background image is a separate
feature under **Settings → admin → overview**.

## Token reference

Every token below is declared on `:root` and can be overridden there. Values
shown are the defaults.

### Colour primitives

Translucent tokens are derived from these with `color-mix`, so overriding one
primitive updates every tint built on it.

| Token            | Default   | What it drives                               |
| ---------------- | --------- | -------------------------------------------- |
| `--scrim`        | `#000000` | The veil under modals and over media         |
| `--surface-tint` | `#ffffff` | Hover films and controls floating on media   |
| `--shadow`       | `#000000` | The colour every elevation shadow is cast in |

### Backgrounds

| Token                    | Default                 | Where it shows                           |
| ------------------------ | ----------------------- | ---------------------------------------- |
| `--bg-primary`           | `#0a0a0a`               | App background, message area             |
| `--bg-secondary`         | `#111111`               | Sidebars, panels, modal bodies           |
| `--bg-tertiary`          | `#1a1a1a`               | Inputs, inset wells, code blocks         |
| `--bg-hover`             | `#262626`               | Hovered rows and buttons                 |
| `--bg-active`            | `#2d2d2d`               | Selected channel / pressed state         |
| `--bg-surface`           | `#1a1a1a`               | Raised cards                             |
| `--media-bg`             | `#000000`               | Letterbox behind video and screen shares |
| `--modal-bg`             | 94% of `--bg-secondary` | Modal panel                              |
| `--modal-backdrop`       | 60% of `--scrim`        | Dimmer behind modals                     |
| `--glass-primary`        | 82% of `--bg-primary`   | Blurred mobile bars                      |
| `--glass-secondary`      | 82% of `--bg-secondary` | Blurred sheets and tab bar               |
| `--glass-secondary-weak` | 65% of `--bg-secondary` | Lighter blurred chrome                   |

### Text and borders

| Token               | Default                | Where it shows                  |
| ------------------- | ---------------------- | ------------------------------- |
| `--text-primary`    | `#ffffff`              | Message body, headings          |
| `--text-secondary`  | `#a0a0a0`              | Channel names, metadata         |
| `--text-muted`      | `#808080`              | Timestamps, placeholders, hints |
| `--border-color`    | `#2a2a2a`              | Panel dividers, input borders   |
| `--border-hairline` | 6% of `--surface-tint` | Separators over blurred chrome  |

### Brand and accent

| Token                | Default          | Where it shows                             |
| -------------------- | ---------------- | ------------------------------------------ |
| `--brand`            | `#a1d93f`        | Primary buttons, active states, focus ring |
| `--brand-hover`      | `#8cc22e`        | Hovered primary buttons                    |
| `--brand-dim`        | 15% of `--brand` | Tinted backgrounds for selected items      |
| `--brand-dim-border` | 25% of `--brand` | Borders on those tinted surfaces           |
| `--brand-glow`       | 20% of `--brand` | Speaking rings, emphasis halos             |
| `--accent-color`     | `#a1d93f`        | Bot badges, chips, secondary emphasis      |

### Semantic colours

| Token                                                 | Default                           | Meaning                                        |
| ----------------------------------------------------- | --------------------------------- | ---------------------------------------------- |
| `--red` / `--red-hover`                               | `#ff4d4d` / `#ff3333`             | Destructive actions, mute state, unread badges |
| `--red-dim` / `--red-dim-border`                      | 15% / 30% of `--red`              | Danger surfaces                                |
| `--green` / `--green-hover`                           | `#40c057` / darkened              | Join, connected, online                        |
| `--green-dim` / `--green-dim-border` / `--green-glow` | 15% / 20% / 50% of `--green`      | Success surfaces and rings                     |
| `--yellow`                                            | `#fab005`                         | Warnings, locked servers, idle                 |
| `--yellow-dim` / `--yellow-dim-border`                | 15% / 30% of `--yellow`           | Warning surfaces                               |
| `--success` / `--error` / `--warning`                 | `#4ade80` / `#f87171` / `#fbbf24` | Inline status text                             |
| `--success-faded` / `--error-faded`                   | `#86efac` / `#fca5a5`             | Softer status text                             |
| `--success-bg` / `--error-bg`                         | 12% of each                       | Status backgrounds                             |
| `--gray`                                              | `#6b7280`                         | Offline presence                               |
| `--avatar-bg-default`                                 | `#374151`                         | Avatar fallback                                |

### "On" colours

What labels and icons turn when they sit **on** a filled surface rather than on
the page. If your palette is bright, these are the tokens that keep text
readable — a pale brand needs dark labels on its buttons.

| Token          | Default   | Sits on                            |
| -------------- | --------- | ---------------------------------- |
| `--on-brand`   | `#ffffff` | `--brand` / `--accent-color` fills |
| `--on-danger`  | `#ffffff` | `--red` fills                      |
| `--on-success` | `#ffffff` | `--green` fills                    |
| `--on-warning` | `#000000` | `--yellow` fills                   |
| `--on-media`   | `#ffffff` | Images, video, scrims              |

### Shape

| Token                     | Default        | Notes                                     |
| ------------------------- | -------------- | ----------------------------------------- |
| `--radius-xs`             | `4px`          | Badges, tiny chips                        |
| `--radius-sm`             | `8px`          | Buttons, inputs, tooltips                 |
| `--radius-md`             | `12px`         | Cards, message bubbles                    |
| `--radius-lg`             | `16px`         | Panels — drops to `12px` under 480px wide |
| `--radius-xl`             | `24px`         | Sheets — drops to `18px` under 480px wide |
| `--radius-full`           | `9999px`       | Pills and avatars                         |
| `--space-1` … `--space-6` | `4px` … `24px` | Spacing scale                             |

### Elevation

Shadows share one colour (`--shadow`) and differ only in geometry. Set
`--shadow` to a brand hue to turn every shadow in the app into a glow, or
redefine the levels outright.

| Token                         | Default                                       |
| ----------------------------- | --------------------------------------------- |
| `--elev-0`                    | `none`                                        |
| `--elev-1`                    | `0 1px 3px` at 30%                            |
| `--elev-2`                    | `0 4px 12px` at 40%                           |
| `--elev-3`                    | `0 8px 32px` at 50%, plus a tight `0 2px 8px` |
| `--elev-4`                    | `0 -8px 32px` at 50% (bottom sheets)          |
| `--elev-up-1` / `--elev-up-2` | Upward casts for bottom-anchored bars         |
| `--focus-ring`                | Two-ring `box-shadow` using `--brand`         |

### Typography

| Token                                         | Default                                                     |
| --------------------------------------------- | ----------------------------------------------------------- |
| `--fs-xs` … `--fs-xl`                         | `0.6875rem` … `1.25rem`                                     |
| `--fw-medium` / `--fw-semibold` / `--fw-bold` | `500` / `600` / `700`                                       |
| `--font-mono`                                 | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace` |

The body font is not a token. To change it, target `body` directly — and
remember you can only name fonts already installed on the member's machine.

### Code blocks

The syntax palette (Material Palenight by default). `--code-fg` is the colour
for anything unmapped.

`--code-fg` · `--code-keyword` · `--code-type` · `--code-builtin` ·
`--code-number` · `--code-string` · `--code-symbol` · `--code-comment` ·
`--code-attr` · `--code-invalid`

### Motion

| Token                                                                                 | Default       | Used for                    |
| ------------------------------------------------------------------------------------- | ------------- | --------------------------- |
| `--dur-tap`                                                                           | `40ms`        | Press feedback              |
| `--dur-fast`                                                                          | `120ms`       | Small control state changes |
| `--dur-base`                                                                          | `150ms`       | The house default           |
| `--dur-slow`                                                                          | `200ms`       | Panels, list reorders       |
| `--dur-sheet`                                                                         | `280ms`       | Sheets and modals entering  |
| `--dur-nav`                                                                           | `320ms`       | Mobile stack push/pop       |
| `--ease-standard` / `--ease-out` / `--ease-in` / `--ease-decel` / `--ease-emphasized` | cubic-béziers | Easing scale                |

### Layers and sizes

`--z-base` `1` · `--z-panel` `10` · `--z-drawer` `40` · `--z-banner` `50` ·
`--z-overlay` `100` · `--z-popover` `1000` · `--z-modal` `2000` ·
`--z-toast` `3000` · `--z-tooltip` `9999`

`--modal-w-xs` … `--modal-w-lg` (`400px` … `600px`, each clamped to `92vw`),
`--settings-modal-w` / `--settings-modal-h`.

## Things worth knowing

**`:root` overrides always win.** Your stylesheet loads last, so equal
specificity goes your way. You do not need `!important` for tokens.

**Class-level rules may need `!important`.** Some parts of the app load their
stylesheet on demand — open a modal for the first time and its CSS arrives
_after_ yours. Token overrides are immune to this because nothing else
declares them on `:root`, but if you target a class directly, add
`!important` so load order cannot beat you.

**A few tokens are scoped to their component, not `:root`.** Overriding these
globally does nothing; target the component instead.

```css
/* wrong — the component redeclares it on itself */
:root {
  --avatar-size: 48px;
}

/* right */
.avatar {
  --avatar-size: 48px;
}
```

The scoped ones are `--avatar-size` and `--avatar-ring-width` (on `.avatar`),
and `--settings-slider-label-w` / `--settings-slider-value-w` (on
`.settings-tab-content`).

**Three tokens are set by the app at runtime.** `--bg-image` and `--bg-blur`
carry the server background; `--keyboard-height` tracks the on-screen keyboard
on mobile. Reading them is fine, overriding them breaks those features.

**Going light means setting `color-scheme`.** The palette ships dark-only and
declares `color-scheme: dark`, which is what keeps OS-drawn UI — native
`<select>` popups, form controls, default scrollbars — from rendering
light-on-light. A light theme must flip it, or those controls stay dark:

```css
:root {
  color-scheme: light;
  --surface-tint: #000000; /* hover films are dark on a light surface */
}
```

**The app overrides some tokens inside media queries.** `--radius-lg` and
`--radius-xl` shrink below 480px, and every `--dur-*` collapses to `1ms` under
`prefers-reduced-motion: reduce`. A plain `:root` override of yours beats both,
because it comes later. If you want to keep the responsive behaviour, redeclare
it inside the same query.

**Please leave reduced motion alone.** If you override the duration tokens,
mirror the app's behaviour so members who ask for less motion still get it:

```css
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-tap: 1ms;
    --dur-fast: 1ms;
    --dur-base: 1ms;
    --dur-slow: 1ms;
    --dur-sheet: 1ms;
    --dur-nav: 1ms;
  }
}
```

**Check your contrast.** Body text should hold at least 4.5:1 against the
background behind it. The `--on-*` tokens exist so you can fix button labels
without touching anything else.

**If you paint yourself into a corner,** turn off **enable custom css** in your
own profile settings, then clear the editor and save.

## Recipes

### Just change the accent

```css
:root {
  --brand: #7c3aed;
  --brand-hover: #6d28d9;
  --accent-color: #7c3aed;
}
```

`--brand-dim`, `--brand-dim-border`, `--brand-glow`, and the focus ring all
follow automatically.

### Turn shadows into glows

```css
:root {
  --shadow: #7c3aed;
}
```

### Square everything off

```css
:root {
  --radius-xs: 0;
  --radius-sm: 0;
  --radius-md: 0;
  --radius-lg: 0;
  --radius-xl: 0;
  --radius-full: 0;
}
```

### Restyle code blocks only

```css
:root {
  --code-fg: #d4d4d4;
  --code-keyword: #569cd6;
  --code-string: #ce9178;
  --code-comment: #6a9955;
  --code-number: #b5cea8;
  --code-type: #4ec9b0;
  --code-builtin: #dcdcaa;
  --code-symbol: #9cdcfe;
  --code-attr: #9cdcfe;
  --code-invalid: #f44747;
}
```

## Example: Vaporwave

A complete theme that changes every axis of the default look — deep purple
instead of near-black, magenta and cyan instead of lime, pill geometry instead
of modest rounding, and neon glows instead of black shadows. Copy the whole
thing into the custom CSS editor.

```css
/* ══════════════════════════════════════════════
   VAPORWAVE — a Kizuna theme
   ══════════════════════════════════════════════ */

:root {
  /* ── Primitives ───────────────────────────── */
  --scrim: #0d0018;
  --surface-tint: #ff7ae0;
  --shadow: #ff2ec4;

  /* ── Backgrounds ──────────────────────────── */
  --bg-primary: #1a0b2e;
  --bg-secondary: #24123f;
  --bg-tertiary: #2f1a52;
  --bg-hover: #3d2268;
  --bg-active: #4a2b7d;
  --bg-surface: #2f1a52;
  --media-bg: #0d0018;

  /* ── Text ─────────────────────────────────── */
  --text-primary: #f0e6ff;
  --text-secondary: #c4a6ee;
  --text-muted: #9070c4;

  /* ── Borders ──────────────────────────────── */
  --border-color: #4a2b7d;

  /* ── Brand: magenta, with cyan as the accent ─ */
  --brand: #ff2ec4;
  --brand-hover: #ff5fd2;
  --accent-color: #2ee5ff;

  /* ── Semantic ─────────────────────────────── */
  --red: #ff3d6e;
  --red-hover: #ff5c85;
  --green: #2ee5ff;
  --yellow: #ffd93d;
  --gray: #9070c4;
  --avatar-bg-default: #4a2b7d;
  --success: #2ee5ff;
  --error: #ff3d6e;
  --warning: #ffd93d;
  --success-faded: #9df4ff;
  --error-faded: #ff9db5;

  /* Every fill in this palette is bright, so labels go dark. */
  --on-brand: #12002b;
  --on-danger: #12002b;
  --on-success: #12002b;
  --on-warning: #12002b;
  --on-media: #ffffff;

  /* ── Shape: everything is a pill ──────────── */
  --radius-xs: 8px;
  --radius-sm: 14px;
  --radius-md: 20px;
  --radius-lg: 28px;
  --radius-xl: 36px;

  /* ── Elevation: neon glow, no black ───────── */
  --elev-1: 0 0 10px color-mix(in srgb, var(--brand) 30%, transparent);
  --elev-2: 0 0 22px color-mix(in srgb, var(--brand) 40%, transparent);
  --elev-3:
    0 0 44px color-mix(in srgb, var(--brand) 45%, transparent),
    0 0 14px color-mix(in srgb, var(--accent-color) 35%, transparent);
  --elev-4: 0 -6px 40px color-mix(in srgb, var(--brand) 40%, transparent);
  --elev-up-1: 0 -1px 10px color-mix(in srgb, var(--brand) 35%, transparent);
  --elev-up-2: 0 -4px 30px color-mix(in srgb, var(--brand) 45%, transparent);

  --focus-ring:
    0 0 0 2px var(--bg-primary), 0 0 0 4px var(--accent-color),
    0 0 18px color-mix(in srgb, var(--accent-color) 70%, transparent);

  /* ── Motion: slower, with an overshoot ────── */
  --dur-fast: 160ms;
  --dur-base: 220ms;
  --dur-slow: 300ms;
  --ease-standard: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-out: cubic-bezier(0.34, 1.56, 0.64, 1);

  /* ── Code blocks ──────────────────────────── */
  --code-fg: #f0e6ff;
  --code-keyword: #ff2ec4;
  --code-type: #2ee5ff;
  --code-builtin: #ffd93d;
  --code-number: #ff9de2;
  --code-string: #7dffd4;
  --code-symbol: #2ee5ff;
  --code-comment: #7a5aa8;
  --code-attr: #ffd93d;
  --code-invalid: #ff3d6e;
}

/* Keep reduced-motion honest — the overrides above would otherwise
   reintroduce animation for members who asked for none. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-tap: 1ms;
    --dur-fast: 1ms;
    --dur-base: 1ms;
    --dur-slow: 1ms;
    --dur-sheet: 1ms;
    --dur-nav: 1ms;
  }
}

/* ── Beyond the tokens ────────────────────────
   Class-level rules need !important, because some component stylesheets
   load on demand and would otherwise land after this one. */

/* A sunset gradient behind the whole app. */
body {
  background: linear-gradient(170deg, #1a0b2e 0%, #2a0f45 55%, #4a1259 100%) !important;
}

/* Glowing rails instead of flat panels. */
.server-panel,
.sidebar,
.member-list {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, #24123f 92%, transparent),
    color-mix(in srgb, #1a0b2e 92%, transparent)
  ) !important;
  border-color: color-mix(in srgb, var(--brand) 30%, transparent) !important;
}

/* Chat header as a neon strip. */
.chat-area__header {
  border-bottom: 1px solid color-mix(in srgb, var(--accent-color) 45%, transparent) !important;
  box-shadow: 0 1px 18px color-mix(in srgb, var(--accent-color) 22%, transparent) !important;
}

/* Message bubbles get a faint magenta rim. */
.msg-bubble__bubble {
  border: 1px solid color-mix(in srgb, var(--brand) 18%, transparent) !important;
}

/* Primary buttons glow on hover. */
.btn-primary:hover,
.server-menu__save-btn:hover {
  box-shadow: 0 0 20px color-mix(in srgb, var(--brand) 65%, transparent) !important;
}
```

## Sharing a theme

A theme is a plain `.css` file. Post it, drop it in a gist, paste it into a
channel — anyone running a Kizuna server can paste it into their own custom CSS
editor. There is no packaging step and no registry.
