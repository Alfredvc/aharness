const CORE_RANGE_PATTERN = /("@aharness\/core"\s*:\s*")\^?([^"]+)(")/g;

function parseVersion(contents) {
  const match = /"@aharness\/core"\s*:\s*"\^?([^"]+)"/.exec(contents);
  if (!match) {
    throw new Error('could not find @aharness/core dependency range');
  }
  return match[1];
}

module.exports.readVersion = function readVersion(contents) {
  return parseVersion(contents);
};

module.exports.writeVersion = function writeVersion(contents, version) {
  const next = contents.replace(CORE_RANGE_PATTERN, `$1^${version}$3`);
  if (next === contents) {
    throw new Error('could not update @aharness/core dependency range');
  }
  return next;
};
