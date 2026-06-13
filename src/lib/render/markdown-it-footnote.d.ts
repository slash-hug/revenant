// Ambient type declaration for markdown-it-footnote.
// The package ships no TypeScript declarations; this stub satisfies tsc.
declare module 'markdown-it-footnote' {
  // A MarkdownIt plugin is a function that accepts a MarkdownIt instance and optional options.
  // Typed loosely to avoid importing the MarkdownIt namespace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MarkdownItFootnote: (md: any, ...args: any[]) => void;
  export default MarkdownItFootnote;
}
