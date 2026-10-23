const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Expo config plugin to ensure APK Signature Scheme v2 and v1 are explicitly enabled
 * in android/app/build.gradle.
 *
 * Android 11+ (API 30+) requires APK Signature Scheme v2. Without it, modern devices
 * fail installation with "App not installed as package appears to be invalid."
 */
const withV2Signing = (config) => {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      let contents = config.modResults.contents;

      // Inject v1SigningEnabled and v2SigningEnabled into signingConfigs.debug block
      // if not already present
      if (!contents.includes('v2SigningEnabled')) {
        contents = contents.replace(
          /signingConfigs\s*\{([\s\S]*?)debug\s*\{([\s\S]*?)\}/,
          (match, beforeDebug, debugBody) => {
            const additions = `\n            v1SigningEnabled true\n            v2SigningEnabled true`;
            return `signingConfigs {${beforeDebug}debug {${debugBody}${additions}\n        }`;
          }
        );
        config.modResults.contents = contents;
      }
    }
    return config;
  });
};

module.exports = withV2Signing;
