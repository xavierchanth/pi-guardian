export function normalizeSessionTitle(value: string, maxWords: number): string {
  const cleaned = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s#>*_`'"“”‘’-]+|[\s#>*_`'"“”‘’.,:;!?-]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.split(" ").slice(0, maxWords).join(" ");
}

export function heuristicSessionTitle(prompt: string, maxWords: number): string {
  const withoutCommand = prompt.trim().replace(/^\/\S+\s*/, "");
  const sentence = withoutCommand.split(/[\r\n.!?]/, 1)[0] ?? withoutCommand;
  const normalized = normalizeSessionTitle(sentence, maxWords) || "New session";
  return normalized.charAt(0).toLocaleUpperCase() + normalized.slice(1);
}

export function isMeaningfulPrompt(prompt: string): boolean {
  const value = prompt.trim();
  if (value.length < 3) return false;
  return !/^\/\S+\s*$/.test(value);
}
