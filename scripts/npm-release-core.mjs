import assert from "node:assert/strict";

export const registry = "https://registry.npmjs.org/";

export function versionParts(version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Automatic releases require a stable x.y.z version");
  const parts = version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version components exceed the safe integer range");
  return parts;
}

export function newer(candidate, latest) {
  const left = versionParts(candidate);
  const right = versionParts(latest);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

export function identity(entry, repository, manifest) {
  assert.ok(entry?.npmPackage && ["automatic", "approval"].includes(entry.npmRelease), "Repository has no enabled, owned npm release channel");
  assert.equal(manifest.name, entry.npmPackage, "Package name differs from the owned npm channel");
  assert.notEqual(manifest.private, true, "Private packages cannot be released");
  versionParts(manifest.version);
  const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  assert.equal(url?.replace(/^git\+/, "").replace(/\.git\/?$/, "").replace(/\/$/, ""), `https://github.com/${repository}`, "Package repository identity differs from its caller");
  const config = manifest.publishConfig ?? {};
  function inspect(object) {
    for (const [key, value] of Object.entries(object)) {
      assert.ok(!/auth|password|username|token|otp|certfile|keyfile/i.test(key), "Credential-shaped publishConfig is forbidden");
      if (value && typeof value === "object") inspect(value);
      if (/registry$/i.test(key)) assert.equal(value?.replace(/\/$/, ""), registry.replace(/\/$/, ""), "Only the public npm registry is allowed");
    }
  }
  inspect(config);
  assert.equal(config.tag ?? "latest", "latest", "Only the latest channel is automated");
  assert.ok(config.access === undefined || config.access === "public", "Only public publishing is allowed");
  assert.notEqual(config.provenance, false, "Automatic releases require npm provenance");
}

export const sourceMarker = (source) => `<!-- pi-npm-source: ${source} -->`;
export function markedSource(text) {
  return /^<!-- pi-npm-source: ([a-f0-9]{40}) -->$/m.exec(text ?? "")?.[1];
}
