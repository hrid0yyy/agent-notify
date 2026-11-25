import fs from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/set-version.mjs MAJOR.MINOR.PATCH");
  process.exit(1);
}

const packagePath = "package.json";
const lockPath = "package-lock.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

console.log(`package version set to ${version}`);
