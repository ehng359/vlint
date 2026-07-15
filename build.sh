#!/bin/bash
set -e

REPO_ROOT=$(pwd)

# 1. Build core
npm run build --workspace=packages/core

# 2. Inject core into extension's local node_modules
mkdir -p packages/extension/node_modules/@vlint/core/dist
cp -r packages/core/dist/. packages/extension/node_modules/@vlint/core/dist/
cp packages/core/package.json packages/extension/node_modules/@vlint/core/

# 3. Install Babel locally in extension
cd packages/extension
npm install @babel/core @babel/parser @babel/traverse @babel/generator @babel/types --prefix .
cd "$REPO_ROOT"

# 4. Bundle
npx esbuild packages/extension/src/extension.ts \
  --bundle \
  --outfile=packages/extension/dist/extension.js \
  --external:vscode \
  --format=cjs \
  --platform=node \
  --minify

# 5. Package
cd packages/extension
npx vsce package --no-dependencies --allow-missing-repository --out "$REPO_ROOT/vlint.vsix"


echo "✓ Built: $REPO_ROOT/vlint.vsix"