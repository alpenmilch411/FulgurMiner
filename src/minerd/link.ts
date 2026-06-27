// src/minerd/link.ts
//
// Terminal hyperlink (OSC 8) helper, shared by the menu (menu.ts) and the
// dashboard (tui.ts) so a pool's website host can be rendered as a clickable
// link. Terminals that understand OSC 8 make the text clickable; terminals that
// don't simply show the plain text — the escape wrapper is invisible either way.
//
// OSC 8 form:  ESC ] 8 ; ; <url> ST  <text>  ESC ] 8 ; ; ST
// where ST (string terminator) is ESC \  (we always emit the ESC \ form).
//
// IMPORTANT for width math: the wrapper bytes are zero-width. The width helpers
// in menu.ts / tui.ts must strip both the OSC 8 sequences AND the usual CSI/SGR
// colour codes before measuring or truncating, or a hyperlinked host would be
// mis-counted and could push a framed row past its border. STRIP_OSC8 below is
// the canonical pattern those helpers reuse.

const ESC = '\x1b';

/**
 * Wrap `text` as an OSC 8 hyperlink to `url`. If `url` is empty/blank the text
 * is returned unchanged (no point emitting an empty link). The visible glyphs
 * are exactly `text`; everything else is a zero-width control sequence.
 */
export function link(text: string, url: string | undefined): string {
  const u = (url ?? '').trim();
  if (!u) return text;
  return `${ESC}]8;;${u}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/**
 * Canonical regex source that matches an OSC 8 hyperlink wrapper (the
 * `ESC ] 8 ; ; <url> ST` opener/closer, ST = `ESC \` or BEL `\x07`). Width
 * helpers strip this (in addition to CSI/SGR) so the wrapper counts as
 * zero-width. Exposed as a string so callers can compose one RegExp with their
 * existing CSI matcher.
 */
// eslint-disable-next-line no-control-regex
export const STRIP_OSC8 = /\x1b\]8;;.*?(\x1b\\|\x07)/g;

/** CSI/SGR matcher (colour, cursor, erase …). */
// eslint-disable-next-line no-control-regex
export const STRIP_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Strip every zero-width terminal control sequence we emit (OSC 8 wrappers and
 * CSI/SGR codes) so the remaining string is exactly the visible glyphs. Used by
 * the menu / dashboard width helpers.
 */
export function stripAnsi(s: string): string {
  return s.replace(STRIP_OSC8, '').replace(STRIP_CSI, '');
}

/** Visible width of a string (glyphs only), ignoring OSC 8 + CSI/SGR codes. */
export function visibleLen(s: string): number {
  return stripAnsi(s).length;
}
