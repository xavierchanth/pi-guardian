import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal-column width for plain dashboard text (which never contains ANSI controls). */
export function visibleWidth(value: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    const codePoint = segment.codePointAt(0);
    if (codePoint === undefined) continue;
    // Emoji grapheme clusters occupy one double-width terminal cell pair.
    if (/\p{Extended_Pictographic}/u.test(segment)) width += 2;
    else width += eastAsianWidth(codePoint);
  }
  return width;
}

export function truncateToWidth(value: string, width: number, suffix = ""): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const ending = truncateBare(suffix, width);
  return truncateBare(value, width - visibleWidth(ending)) + ending;
}

function truncateBare(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const columns = visibleWidth(segment);
    if (used + columns > width) break;
    result += segment;
    used += columns;
  }
  return result;
}
