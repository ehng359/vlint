# Change Log

All notable changes to the "vlint" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.1] - 2026-07-21

- **vlint: Connect Figma** command: paste a file link and a token once to configure the workspace, no manual `design.manifest` editing. The token goes to secret storage.
- `theme.x.y` references are validated against the property's bound Figma token; naming the wrong token is a token-mismatch error.

## [0.1.0] - 2026-07-17

- Save-time validation of React inline styles, Tailwind classes, and CSS modules against a Figma design contract, with diagnostics and "Apply Figma value" quick fixes.