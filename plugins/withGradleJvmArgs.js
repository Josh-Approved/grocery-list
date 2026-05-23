const { withGradleProperties } = require('expo/config-plugins');

// Expo prebuild regenerates android/gradle.properties with a default
// org.gradle.jvmargs of -Xmx2048m -XX:MaxMetaspaceSize=512m. The Gradle
// daemon reads that file (it wins over GRADLE_OPTS), and 512m Metaspace
// OOMs the expo-updates KSP / RN-screens lint tasks in a release build.
// This rewrites the value at prebuild so it survives CNG regeneration.
// Kept matched to .github/workflows/qa-e2e.yml's GRADLE_OPTS.
const JVM_ARGS = '-Xmx4g -XX:MaxMetaspaceSize=1g';

module.exports = function withGradleJvmArgs(config) {
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'org.gradle.jvmargs')
    );
    cfg.modResults.push({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: JVM_ARGS,
    });
    return cfg;
  });
};
