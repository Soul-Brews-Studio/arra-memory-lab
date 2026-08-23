# Arra Memory Lab — interface design

## Intent

The interface should feel like a small scientific instrument: precise, calm, and inspectable. It is not a chat UI. It makes authority, provenance, degradation, and mutation impact visible without turning the lab into an operations dashboard.

## Principles

1. **Authority is spatial.** The architecture tier row is the first substantive section and visually distinguishes the authoritative memory tier from derived tiers.
2. **Safety is procedural.** Forget and rebuild always show a preview before exposing confirmation.
3. **Provenance stays adjacent.** Trace IDs, search modes, and ranks sit beside recall results; evidence and supersession snapshots stay beside their source records.
4. **Status is not color-only.** Active, stale, retracted, completed, and failed states always include text labels.
5. **Dense, not cramped.** Monospace operational metadata contrasts with readable prose, with responsive single-column layouts below tablet width.

## Typography

- **Local UI sans stack** — interface text, headings, forms, and primary reading, using `ui-sans-serif`, platform UI fonts, and `Segoe UI` fallbacks.
- **Local serif stack** — one italic editorial accent in the hero, using Georgia and Times fallbacks; never used for controls or dense data.
- **Local monospace stack** — IDs, hashes, ranks, modes, timestamps, eyebrow labels, and traces, using `ui-monospace`, SFMono, Consolas, and Liberation Mono fallbacks.
- No font or stylesheet is fetched from a third party. Typography respects the lab's CSP and privacy boundary: runtime UI resources are self-hosted or supplied by the operating system.

## Palette

| Token | Value | Purpose |
| --- | --- | --- |
| Background | `#080d14` | page canvas |
| Panel | `#101824` | raised working surfaces |
| Ink | `#e8edf4` | primary text |
| Muted | `#8895a6` | secondary text |
| Line | `#263242` | borders and structure |
| Mint | `#73e8c2` | authority, healthy status, action |
| Amber | `#f0be68` | derivation, degradation, caution |
| Red | `#ff7a75` | destructive/retracted/failed |
| Supporting ink | `#acb7c5`, `#c7d0db`, `#aab5c3`, `#a9b4c2` | readable secondary prose |
| Supporting surfaces | `#11271f`, `#255b4b`, `#0d1621`, `#0c131d`, `#080e16`, `#070b11` | authority, coverage, table, and input states |
| Warning surface | `#744442`, `#1b0909` | destructive preview emphasis |

Color is never the sole carrier of meaning. Borders, labels, arrows, percentages, and status copy remain legible in grayscale.

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
- Disabled mutation controls signal missing authorization or active requests.
- Forget confirmation appears only after a successful `{confirm:false}` response and submits the exact revision/hash/impact fields from that preview; a `stale_preview` response closes the destructive branch until the user previews again.
- Rebuild confirmation appears only after a successful dry-run response.
- Remember exposes one optional superseded-memory selector. The stored relationship renders as the pinned ID/revision/hash snapshot, without graph controls.
- Motion is limited to short hover/focus feedback and respects the browser's normal reduced-motion handling (no ambient or scroll animation is required for comprehension).

## Information boundary

The public `/api/info` view may disclose architecture, model, and MCP tools. Corpus cards, observations, evidence, coverage, and traces come only from bearer-protected `/api/state`. Search traces deliberately render IDs, ranks, scores, revisions, and hashes, never query strings or corpus excerpts.
