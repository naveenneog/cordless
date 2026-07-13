// Map a tab-group color name (from the daemon) to a CSS color for chips/dots.
const COLORS: Record<string, string> = {
  blue: "#5aa2ff",
  green: "#4cc38a",
  yellow: "#e5c07b",
  red: "#f7768e",
  purple: "#bb9af7",
  gray: "#8a94a7",
};

export function groupColor(name: string | undefined | null): string {
  return (name && COLORS[name]) || COLORS.gray;
}
