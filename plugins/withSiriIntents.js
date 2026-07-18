const {
  withEntitlementsPlist,
  withDangerousMod,
  withXcodeProject,
  IOSConfig,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Siri "add an item" integration (iOS only).
//
// App Shortcuts + App Intents must live in the MAIN APP TARGET for the App
// Intents metadata processor to index them and for Siri to invoke the spoken
// phrases with zero user setup — a Pod/framework won't do. So this plugin, at
// prebuild time:
//   1. adds the App Group entitlement (the intent + the JS bridge share it);
//   2. copies the Swift sources from `plugins/siri/` into the app target dir;
//   3. registers them with the app target's Sources build phase.
// The JS-callable side (reading the App Group) is the separate autolinked
// `modules/grocery-siri` pod, which runs in-process and uses the app's App
// Group entitlement.

const APP_GROUP = 'group.com.joshapproved.grocerylist';
const SRC_DIR = path.join('plugins', 'siri');
const DEST_SUBDIR = 'Siri';
const SWIFT_FILES = [
  'SiriStore.swift',
  'AddGroceryItemIntent.swift',
  'GroceryAppShortcuts.swift',
];

function withAppGroupEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const key = 'com.apple.security.application-groups';
    const groups = new Set(cfg.modResults[key] || []);
    groups.add(APP_GROUP);
    cfg.modResults[key] = [...groups];
    return cfg;
  });
}

function withCopiedSwiftSources(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const { projectRoot, platformProjectRoot, projectName } =
        cfg.modRequest;
      const destDir = path.join(platformProjectRoot, projectName, DEST_SUBDIR);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of SWIFT_FILES) {
        const src = path.join(projectRoot, SRC_DIR, file);
        fs.copyFileSync(src, path.join(destDir, file));
      }
      return cfg;
    },
  ]);
}

function withSwiftSourcesInTarget(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { projectName } = cfg.modRequest;
    const groupName = `${projectName}/${DEST_SUBDIR}`;
    for (const file of SWIFT_FILES) {
      const filepath = `${projectName}/${DEST_SUBDIR}/${file}`;
      // Idempotent: skip if this prebuild already added it.
      if (project.hasFile(filepath)) continue;
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName,
        project,
      });
    }
    return cfg;
  });
}

module.exports = function withSiriIntents(config) {
  config = withAppGroupEntitlement(config);
  config = withCopiedSwiftSources(config);
  config = withSwiftSourcesInTarget(config);
  return config;
};
