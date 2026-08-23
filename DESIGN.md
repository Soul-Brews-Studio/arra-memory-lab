# Arra Memory Lab — interface design

## Intent

The interface should feel like a small scientific instrument laid out on an artist's worktable: precise, inspectable, and unusually alive. It is not a chat UI. It makes authority, provenance, degradation, and mutation impact visible without turning the lab into an operations dashboard. Color gives the instrument identity, but never changes the meaning of its controls or evidence.

## Principles

1. **Authority is spatial.** The architecture tier row is the first substantive section and visually distinguishes the authoritative memory tier from derived tiers.
2. **Safety is procedural.** Forget and rebuild always show a preview before exposing confirmation.
3. **Provenance stays adjacent.** Trace IDs, search modes, and ranks sit beside recall results; evidence and supersession snapshots stay beside their source records.
4. **Status is not color-only.** Active, stale, retracted, completed, and failed states always include text labels.
5. **Dense, not cramped.** Monospace operational metadata contrasts with readable prose, with responsive single-column layouts below tablet width.

## Typography

- **Local humanist sans stack** — interface text, headings, forms, and primary reading, using Avenir Next, Avenir, and Trebuchet fallbacks for a warmer instrument-panel voice.
- **Local serif stack** — one italic editorial accent in the hero, using Georgia and Times fallbacks; never used for controls or dense data.
- **Local monospace stack** — IDs, hashes, ranks, modes, timestamps, eyebrow labels, and traces, using `ui-monospace`, SFMono, Consolas, and Liberation Mono fallbacks.
- No font or stylesheet is fetched from a third party. Typography respects the lab's CSP and privacy boundary: runtime UI resources are self-hosted or supplied by the operating system.
- **Type ramp** — `10px` metadata, `11px` compact operator labels, `12–14px` controls and evidence, `18–20px` supporting prose/card headings, `32–54px` section headings, and `54–105px` hero display type. Responsive display sizes use `clamp()` within those documented bounds.

Panels use a restrained `4px` radius; controls use `2px`; circular status dots and palette swatches use `50%`. Short hover/focus feedback uses the existing `200ms` motion step and disappears under `prefers-reduced-motion`.

## Palette system

The three palettes are color studies, not reproductions of an artist's work. They share one semantic token contract, so changing the palette never changes component logic or status meaning.

| Palette | Mode | Canvas / surface | Accent | Character |
| --- | --- | --- | --- | --- |
| **Sunflower** (default) | light | warm straw / paper | cobalt | bright daylight, ochre field notes, decisive blue controls |
| **Starry** | dark | midnight cobalt / ink | warm gold | low-light inspection with high-contrast operational detail |
| **Iris** | light | pale violet / warm paper | deep teal | a cooler, botanical field-study palette with coral caution notes |

Components consume semantic roles such as `--canvas`, `--surface-raised`, `--text-primary`, `--text-muted`, `--border`, `--accent`, `--caution`, and `--danger`. Each palette also supplies compatible input, code, evidence, focus, and coverage roles. Raw palette colors appear only in the tiny selector swatches.

The selector swatches are an explicit design-system ramp: Sunflower `#edb71f` / `#1458a6`, Starry `#183f87` / `#ffe071`, and Iris `#7f4aa4` / `#e26c57` / `#006b69`, with a shared translucent white inset highlight. These values identify palettes only; operational state never consumes them directly.

Color is never the sole carrier of meaning. Borders, labels, arrows, percentages, check marks, and status copy remain legible in grayscale. Selected palettes have both an underline and a visible check mark; async and evidence states retain their text labels.

## Layout and responsive behavior

- Content width is capped at 1180px.
- The hero uses a 1.4/0.8 split; workbench and safety areas use equal columns.
- Architecture uses four tiers on desktop, two on tablet, and one on narrow screens.
- Memory cards use three, two, then one column.
- Tables retain their semantic table structure inside a horizontally scrollable, keyboard-focusable region.

## Interaction contracts

- The bearer token is a password input and is copied only to `sessionStorage`.
- The same owner secret may approve an OAuth client, but the connector stores only issued OAuth tokens; the approval page never writes the passphrase to client configuration.
- A live status region reports async success and error messages.
- Native labels, fieldsets, legends, and controls preserve keyboard and screen-reader behavior.
- The palette selector is a native radio group. Arrow keys move among Sunflower, Starry, and Iris; a visible check mark and underline reinforce the selected state.
- The selected palette is validated before use and persists in `localStorage`. Sunflower is the CSS and application default, while a small head bootstrap applies a valid stored value before the client bundle to avoid a wrong-theme first paint.
- `color-scheme` and the document theme color follow the selected palette so native controls and browser chrome remain composed with the page.
- Disabled mutation controls signal missing authorization or active requests.
- Forget confirmation appears only after a successful `{confirm:false}` response and submits the exact revision/hash/impact fields from that preview; a `stale_preview` response closes the destructive branch until the user previews again.
- Rebuild confirmation appears only after a successful dry-run response.
- Remember exposes one optional superseded-memory selector. The stored relationship renders as the pinned ID/revision/hash snapshot, without graph controls.
- Motion is limited to short hover/focus feedback and respects the browser's normal reduced-motion handling (no ambient or scroll animation is required for comprehension).

## Information boundary

The public `/api/info` view may disclose architecture, model, and MCP tools. Corpus cards, observations, evidence, coverage, and traces come only from bearer-protected `/api/state`. Search traces deliberately render IDs, ranks, scores, revisions, and hashes, never query strings or corpus excerpts.
