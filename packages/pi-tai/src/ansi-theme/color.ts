export type ThemeMode = "dark" | "light";

export function parseRgbSpec(spec: string): string | undefined {
  const match = /^rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)$/i.exec(spec.trim());
  if (!match) return undefined;
  const components = match.slice(1).map((component) => {
    const normalized = component.length > 2 ? component.slice(0, 2) : component.padEnd(2, component);
    return Number.parseInt(normalized, 16);
  });
  if (components.some((component) => !Number.isFinite(component))) return undefined;
  return `#${components.map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Invalid RGB color: ${hex}`);
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const [r, g, b] = channels.map((channel) => {
    const component = channel / 255;
    return component <= 0.03928
      ? component / 12.92
      : ((component + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function detectThemeMode(background: string): ThemeMode {
  return relativeLuminance(background) < 0.5 ? "dark" : "light";
}
