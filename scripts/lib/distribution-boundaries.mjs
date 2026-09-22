const sharpLibvipsPlatforms = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm',
  'linux-arm64',
  'linux-ppc64',
  'linux-riscv64',
  'linux-s390x',
  'linux-x64',
  'linuxmusl-arm64',
  'linuxmusl-x64',
]);

export function sharpLibvipsCoordinates() {
  return sharpLibvipsPlatforms.map((platform) => `@img/sharp-libvips-${platform}@1.3.3`);
}

export function isForbiddenNativeExtensionFile(name) {
  return /\.(?:dll|dylib|exe|node|so(?:\.\d+)*)$/iu.test(name);
}
