/**
 * 58 mm receipt layout and ESC/POS encoding. Pure and browser-safe.
 *
 * A 58 mm printer at 203 DPI prints 384 dots: 32 characters of the standard
 * 12x24 font per line, or 16 in double width. Text is reduced to printable
 * ASCII (accents dropped, emoji removed) because cheap printers ship with a
 * single code page.
 */
export const LINE_WIDTH = 32;

export type ReceiptLine = { text: string; align?: "left" | "center"; bold?: boolean; large?: boolean };

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, "-"],
  [/…/g, "..."],
  [/[   ]/g, " "],
  [/×/g, "x"],
];

/** Printable ASCII only. */
export function asciiSafe(text: string): string {
  let s = text;
  for (const [re, to] of REPLACEMENTS) s = s.replace(re, to);
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[^\x20-\x7E]/g, "");
  return s.replace(/ {2,}/g, " ").trim();
}

/** Word-wraps to `width`, breaking long words; continuation lines get `indent` spaces. */
export function wrap(text: string, width = LINE_WIDTH, indent = 0): string[] {
  const words = asciiSafe(text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const room = () => (lines.length === 0 ? width : width - indent);
  const push = () => {
    lines.push(lines.length === 0 ? line : " ".repeat(indent) + line);
    line = "";
  };
  for (let word of words) {
    while (word.length > room()) {
      if (line) push();
      lines.push(lines.length === 0 ? word.slice(0, room()) : " ".repeat(indent) + word.slice(0, room()));
      word = word.slice(lines.length === 1 ? width : width - indent);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= room()) line += ` ${word}`;
    else {
      push();
      line = word;
    }
  }
  if (line || lines.length === 0) push();
  return lines;
}

// ---- builders ---------------------------------------------------------------

export const center = (text: string, opts: { bold?: boolean; large?: boolean } = {}): ReceiptLine => ({ text, align: "center", ...opts });
export const bold = (text: string): ReceiptLine => ({ text, bold: true });
export const text = (t: string): ReceiptLine => ({ text: t });
export const divider = (ch = "-"): ReceiptLine => ({ text: ch.repeat(LINE_WIDTH) });
export const blank = (): ReceiptLine => ({ text: "" });
/** "[ ] Milk (2)" with continuation lines indented under the text. */
export const checkbox = (label: string, checked = false): ReceiptLine => ({ text: `${checked ? "[x]" : "[ ]"} ${label}` });
/** Left and right text on one line ("Ava ........ 3/5"). */
export function columns(left: string, right: string): ReceiptLine {
  const l = asciiSafe(left);
  const r = asciiSafe(right);
  const space = LINE_WIDTH - r.length - 1;
  const lt = l.length > space ? `${l.slice(0, Math.max(0, space - 1))}~` : l;
  return { text: `${lt}${" ".repeat(Math.max(1, LINE_WIDTH - lt.length - r.length))}${r}` };
}

/** Physical lines as they will print (for the preview). */
export function layout(lines: ReceiptLine[]): { text: string; bold: boolean; large: boolean }[] {
  const out: { text: string; bold: boolean; large: boolean }[] = [];
  for (const l of lines) {
    const width = l.large ? LINE_WIDTH / 2 : LINE_WIDTH;
    const isCheckbox = /^\[[ x]\] /.test(l.text);
    const isRule = /^(.)\1+$/.test(l.text) && l.text.length === LINE_WIDTH;
    const wrapped = isRule ? [l.text] : l.text === "" ? [""] : wrap(l.text, width, isCheckbox ? 4 : 0);
    for (const w of wrapped) {
      const padded = l.align === "center" ? " ".repeat(Math.max(0, Math.floor((width - w.length) / 2))) + w : w;
      out.push({ text: padded, bold: Boolean(l.bold), large: Boolean(l.large) });
    }
  }
  return out;
}

export function toPlainText(lines: ReceiptLine[]): string {
  return layout(lines)
    .map((l) => l.text)
    .join("\n");
}

// ---- ESC/POS ----------------------------------------------------------------

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Encodes lines for an ESC/POS printer, ending with a feed and (if fitted) a cut. */
export function toEscPos(lines: ReceiptLine[], opts: { feedLines?: number; cut?: boolean } = {}): Uint8Array {
  const bytes: number[] = [ESC, 0x40]; // initialise
  const enc = new TextEncoder();
  for (const l of lines) {
    const width = l.large ? LINE_WIDTH / 2 : LINE_WIDTH;
    const isCheckbox = /^\[[ x]\] /.test(l.text);
    const isRule = /^(.)\1+$/.test(l.text) && l.text.length === LINE_WIDTH;
    bytes.push(ESC, 0x61, l.align === "center" ? 1 : 0); // align
    bytes.push(ESC, 0x45, l.bold ? 1 : 0); // bold
    bytes.push(GS, 0x21, l.large ? 0x11 : 0x00); // double width + height
    const wrapped = isRule ? [l.text] : l.text === "" ? [""] : wrap(l.text, width, isCheckbox ? 4 : 0);
    for (const w of wrapped) {
      bytes.push(...enc.encode(w), LF);
    }
  }
  bytes.push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0);
  return new Uint8Array([...bytes, ...feedAndCut(opts.feedLines ?? 4, opts.cut ?? true)]);
}

/** Feed `n` lines so the tear bar clears the text, then a partial cut (ignored by printers without a cutter). */
export function feedAndCut(n = 4, cut = true): number[] {
  return [ESC, 0x64, n, ...(cut ? [GS, 0x56, 0x42, 0x00] : [])];
}
