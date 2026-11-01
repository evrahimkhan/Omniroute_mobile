# OmniRoute Mobile (Claude Code Guidelines)

This repository is an Expo SDK 57 / React Native 0.86.3 / React 19 mobile client for OmniRoute with Continuous Native Generation (CNG) and an embedded Node.js runtime.

## Environment & Build Requirements

- **JDK Version**: Java 21 LTS (`/home/maskeddevil/.jdk/temurin-21`). Do not use Java 24/25+ for Android builds as the OpenJDK native-access restrictions cause AGP Prefab CLI tasks to fail.
- **Android SDK**: `$ANDROID_HOME` pointing to `/home/maskeddevil/Android/Sdk` with:
  - NDK: `27.1.12297006`
  - CMake: `3.22.1`
  - Build-tools: `36.0.0`
- **Gradle Properties**: Set `org.gradle.java.home=/home/maskeddevil/.jdk/temurin-21` in `android/gradle.properties`.

## Verification Commands

Run before committing any changes:
```bash
npm run api:test       # 122 API client and catalog assertions
npm run lint           # Expo & ESLint checks
npm run typecheck      # TypeScript compilation check (tsc --noEmit)
```

## Native Android Build Commands

```bash
cd android
export ANDROID_HOME=/home/maskeddevil/Android/Sdk
export JAVA_HOME=/home/maskeddevil/.jdk/temurin-21
./gradlew :app:assembleDebug
```

## Architectural Guidelines

1. **Continuous Native Generation**: Native code under `android/` is managed via Expo prebuild. Never commit manual edits that conflict with `app.json` or config plugins (e.g., `with-v2-signing.js`).
2. **Session Cookies & Auth**: Gateway sessions are scoped per server URL (`omniroute.session.v2:$host`). The client extracts and forwards the session cookie (`omniroute.sid`).
3. **Safe Area Insets**: All top-level screens and toolbars must account for status bar and display cutouts on Android 15 edge-to-edge screens using `useSafeAreaInsets()`.
4. **React 19 Compatibility**:
   - Never mutate or access `ref.current` during render.
   - Avoid synchronous `setState` in `useEffect` hooks; use state change comparison during render or schedule state updates asynchronously.
5. **Node Runtime Service**: Embedded Node runs via Android Foreground Service `GatewayService.kt` (`FOREGROUND_SERVICE_TYPE_SPECIAL_USE` for API 34+), listening on `127.0.0.1:8080`.
