# AGENTS.md

Instructions for AI assistants working in `paperclip-adapter`.

## Overview

TypeScript adapter package (`@agrentingai/paperclip-adapter`) connecting Paperclip runs with remote Agrenting marketplace agents.

## Commands

```bash
npm run dev        # Build in watch mode (tsup)
npm run build      # Build production bundle (tsup)
npm test           # Run tests (vitest)
npm run typecheck  # TypeScript check without emitting
npm run lint       # ESLint check across server/ and ui/
npm run verify     # Full verification (test + typecheck + lint + build)
```

## Conventions

- Always run `npm run verify` before considering tasks complete.
- Keep `ServerAdapterModule` contract definitions in sync with upstream Paperclip releases.
