#!/bin/bash

set -e

# Ensure Node.js is available via PATH or NVM
source "$(dirname "$0")/node-check.sh" || exit 1

echo "Step 1/6: Checking generated SDK capability registry..."
npm run check:sdk-capabilities

echo "Step 2/6: Type checking..."
npm run typecheck

echo "Step 3/6: Linting..."
npm run lint

echo "Step 4/6: Format checking..."
npm run format:check

echo "Step 5/6: Running tests..."
npm run test

echo "Step 6/6: Checking coverage..."
npm run test:coverage

echo "✅ All code quality checks passed!"
