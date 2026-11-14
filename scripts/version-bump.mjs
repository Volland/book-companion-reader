// Usage: npm run version:bump -- 0.2.0
// Updates manifest.json, versions.json and package.json. Then commit and tag the release (tag = version, no "v").
import fs from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
	console.error("Give a version like 0.2.0");
	process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
manifest.version = v;
fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
versions[v] = manifest.minAppVersion;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = v;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

console.log(`Version is now ${v}. Commit it, then tag it ${v} and push the tag to start the release.`);
