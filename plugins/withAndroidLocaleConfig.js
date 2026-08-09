const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Declare the app's translated languages to Android (canon § Translations,
// "Declare localizations in the build").
//
// Our translations are runtime-only — the i18n dictionary swaps inside the JS
// bundle — so the OS has no way to know the app speaks seven languages. Two
// user-visible surfaces depend on the declaration: Android 13+'s per-app
// language screen (Settings > Apps > <App> > Language), and the Play listing's
// Languages field. Without it the app looks English-only in both places.
//
// Android reads this from a `res/xml/locales_config.xml` resource referenced by
// `android:localeConfig` on <application>. Expo's app config has NO
// `android.localeConfig` key — verified against @expo/config-types on both SDK
// 56 and SDK 57; the Android interface carries no locale field at all, so
// writing one into app.json is a silent no-op that reads as done. (`expo.locales`
// is a different feature: it localizes permission prompt strings, not the
// language set.) Hence this config plugin, matching the withGradleJvmArgs
// pattern: it writes the resource and sets the attribute at prebuild, so both
// survive CNG regeneration.
//
// The iOS half of the same requirement is `ios.infoPlist.CFBundleLocalizations`
// in app.json, which Expo does support directly. Both platforms must claim the
// same set — keep LOCALES here, that array, and the app's src/i18n locale list
// in step.

/** en is the build language; the rest are the canon § Translations locale set.
 *  BCP-47 tags, the form both locales_config.xml and CFBundleLocalizations take.
 *  Android maps the region form ("pt-BR") to its own values-b+pt+BR resource. */
const LOCALES = ['en', 'es', 'de', 'fr', 'it', 'pt-BR', 'ja'];

const RESOURCE_NAME = 'locales_config';

/** Pure: the locales_config.xml body. Exported so a drift test can read it
 *  without running a prebuild. */
function buildLocalesConfigXml(locales) {
  const entries = locales.map((l) => `    <locale android:name="${l}"/>`).join('\n');
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    `${entries}\n` +
    '</locale-config>\n'
  );
}

function withLocalesConfigResource(config, locales) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, `${RESOURCE_NAME}.xml`), buildLocalesConfigXml(locales));
      return cfg;
    },
  ]);
}

function withLocaleConfigAttribute(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    application.$['android:localeConfig'] = `@xml/${RESOURCE_NAME}`;
    return cfg;
  });
}

module.exports = function withAndroidLocaleConfig(config, { locales = LOCALES } = {}) {
  return withLocaleConfigAttribute(withLocalesConfigResource(config, locales));
};

module.exports.LOCALES = LOCALES;
module.exports.buildLocalesConfigXml = buildLocalesConfigXml;
