---
name: run-omniroute-mobile
description: "Run, test, build, and verify OmniRoute Mobile (Expo SDK 57 / React Native / Node runtime)."
disable-model-invocation: false
---

# Run OmniRoute Mobile

This skill provides the authoritative agentic path to build, test, and verify OmniRoute Mobile.

## 1. Prerequisites & Environment
- **Node.js** (Active LTS)
- **Java 21 LTS** (`/home/maskeddevil/.jdk/temurin-21`)
- **Android SDK** (`$ANDROID_HOME=/home/maskeddevil/Android/Sdk`)

## 2. Verification & Tests
Run the API client and catalog test suite before committing any changes:
```bash
npm run api:test       # 124 API client and catalog assertions
npm run lint           # Expo & ESLint checks
npm run typecheck      # TypeScript compilation check (tsc --noEmit)
```

## 3. Development Server & Build
```bash
npx expo start         # Start Metro dev server
```
