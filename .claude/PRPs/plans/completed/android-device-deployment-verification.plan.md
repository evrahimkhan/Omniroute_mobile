# Plan: Android Device Deployment and Verification Suite

## Summary
Establish a structured, automated deployment and verification workflow for the OmniRoute mobile client on connected Android devices (`a131deea`), verifying gateway connectivity, session sign-in, and local node runtime integration.

## User Story
As a mobile developer, I want to deploy and verify the OmniRoute client on an attached Android device, so that I can validate real-device rendering, gateway interactions, and foreground service behavior.

## Problem → Solution
Manual deployment on physical/emulated devices often lacks structured validation. We will build a repeatable verification run using ADB and test assertions based on the condition constraints:
- API Assertions: 124 passing
- Type Safety: Zero errors (`tsc --noEmit`)
- Linting: Clean (`expo lint` & ESLint)

## Metadata
- **Complexity**: Small
- **Source PRD**: N/A
- **PRD Phase**: Standalone
- **Estimated Files**: 1

---

## UX Design

### Before
- Manual `npx expo run:android` without structured verification.

### After
- Automated deployment check, logcat monitoring, and API assertion validation on device `a131deea`.

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 (critical) | `lib/api/client.ts` | 1-50 | Core error handling and base URL rules |
| P1 (important) | `lib/api/context.tsx` | 1-40 | Polling and API context hooks |

---

## Step-by-Step Tasks

### Task 1: Verify ADB Connection and Package State
- **ACTION**: Check connected device status and verify app installation.
- **IMPLEMENT**: Run `adb -s a131deea shell getprop ro.product.model` and check package list.
- **VALIDATE**: Ensure device is responsive and package is present.

### Task 2: Run Verification Test Suite
- **ACTION**: Run `npm run api:test`, `npm run typecheck`, and `npm run lint`.
- **VALIDATE**: All 124 API assertions pass, zero type errors, clean lint.

---

## Validation Commands

### Static Analysis
```bash
npm run typecheck
```
EXPECT: Zero type errors

### API Tests
```bash
npm run api:test
```
EXPECT: 124 assertions passing

### Linting
```bash
npm run lint
```
EXPECT: Clean check
