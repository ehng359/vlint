# @vlint/core

The engine behind [vlint](https://github.com/ehng359/vlint): Figma REST extraction, CSS generation with responsive `@media` folding, and static validation of React sources (inline styles, Tailwind classes, CSS modules) against a Figma design contract.

Key entry points: `queryFigmaStyles`, `lintSource`, `checkFile`, `resolveTailwindClasses`, `parseCssModuleClasses`, `applyStyleFixes`.

Consumed by `@vlint/cli`, `@vlint/mcp`, and the vlint VS Code extension. Full documentation lives in the [repository README](https://github.com/ehng359/vlint#readme).
