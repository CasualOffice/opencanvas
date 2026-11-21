// Languages offered by the code block's picker. The ids are highlight.js names
// (lowlight `common`); the `language` attr stores them as-is (docs/15 §4).
// "" means auto-detect. Kept apart from highlight.ts so the picker renders
// before the grammars load.
export const CODE_LANGS: [id: string, label: string][] = [
  ["", "Auto-detect"],
  ["plaintext", "Plain text"],
  ["bash", "Bash"],
  ["c", "C"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["css", "CSS"],
  ["diff", "Diff"],
  ["go", "Go"],
  ["graphql", "GraphQL"],
  ["xml", "HTML / XML"],
  ["ini", "INI / TOML"],
  ["java", "Java"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["kotlin", "Kotlin"],
  ["lua", "Lua"],
  ["makefile", "Makefile"],
  ["markdown", "Markdown"],
  ["objectivec", "Objective-C"],
  ["perl", "Perl"],
  ["php", "PHP"],
  ["python", "Python"],
  ["r", "R"],
  ["ruby", "Ruby"],
  ["rust", "Rust"],
  ["scss", "SCSS"],
  ["shell", "Shell session"],
  ["sql", "SQL"],
  ["swift", "Swift"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
];

const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", rb: "ruby", rs: "rust",
  sh: "bash", zsh: "bash", html: "xml", svg: "xml", yml: "yaml", toml: "ini", md: "markdown", "c++": "cpp",
  "c#": "csharp", cs: "csharp", kt: "kotlin", golang: "go", text: "plaintext", txt: "plaintext", plain: "plaintext",
};

/** Picker id for a stored language attr (aliases folded, case-insensitive). */
export function canonicalLang(lang: string): string {
  const l = lang.trim().toLowerCase();
  return ALIASES[l] ?? l;
}

export function langLabel(id: string): string {
  return CODE_LANGS.find(([k]) => k === id)?.[1] ?? id;
}
