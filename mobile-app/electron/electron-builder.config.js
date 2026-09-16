/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.ensadvantage.app',
  productName: 'ENS Advantage',
  directories: {
    output: 'dist',
    buildResources: 'assets',
  },
  files: [
    'build/**/*',
    'app/**/*',
    'generated/**/*',
    // `assets` is also the electron-builder `buildResources` directory, whose
    // contents are NOT packaged by default. Include it explicitly so the
    // splash screen (and any other runtime assets) ship in the app.
    'assets/**/*',
    'package.json',
    // Platform runtime + plugins, prepared by `capacitor-electron vendor`.
    { from: 'vendor/node_modules', to: 'node_modules' },
  ],
  // assets/icon.png (1024x1024, copied from ../assets/icon.png -- the same
  // source icon the Android/iOS icons were generated from) is converted
  // automatically into both formats below by electron-builder at build
  // time. No pre-built .icns/.ico needed.
  win: {
    target: ['nsis'],
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.education',
  },
};
