// Local Expo module: the JS-facing surface is intentionally in the app's
// `src/siri/native.ts`, which reaches this native module by name via
// `requireOptionalNativeModule('GrocerySiri')` so every call degrades to a
// no-op when the module is absent (Android, Expo Go, tests). This file exists
// only so `modules/grocery-siri` is a valid, autolinked local module.
export {};
