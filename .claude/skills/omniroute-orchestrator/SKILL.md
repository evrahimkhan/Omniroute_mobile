---
name: omniroute-orchestrator
description: "Orchestrator for OmniRoute Mobile (Expo SDK 57 / React Native / Node runtime). Invoke before responding to any domain request (triggers: re-run, update, modify, supplement, improve, check setup, visualise, mock up)."
---

# OmniRoute Mobile Orchestrator

This skill is the single entry point for all OmniRoute Mobile development tasks.

## Phase 1: Intake & Triage
- Triage prompt: off-domain or trivial requests answered directly.
- In-domain work: checks whether `.agents_workspace/` exists (initial run vs follow-up vs partial re-run).
- Routes visual requests ("show me", "draw", "mock up", "visualise") to `omniroute-visuals`.
- Routes setup/doctor requests ("check my setup", "why is tool X unavailable") to `omniroute-setup-check`.

## Phase 2: Execution & Implementation
- Coordinates code edits, native modules, API client verification (`npm run api:test`), linting (`npm run lint`), and typechecking (`npm run typecheck`).
- Follows Expo SDK 57 / React Native 0.86.3 / React 19 rules (safe area insets, no ref mutation during render, session cookies per gateway URL).

## Phase 3: Integration & Verification
- Runs `npm run api:test`, `npm run lint`, and `npm run typecheck`.
- Ensures all native Android builds (`cd android && ./gradlew :app:assembleDebug`) succeed.
