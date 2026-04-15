import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const catalogPath = path.join(rootDir, "config", "error-codes.json");
const servicesDir = path.join(rootDir, "services");

const codeLiteralPattern = /errorCode\s*:\s*"([a-z0-9_]+)"/g;
const sendErrorPattern = /sendError\s*\(\s*[^,]+,\s*\d+\s*,\s*"([a-z0-9_]+)"/g;
const writeErrorPattern = /writeError\s*\(\s*[^,]+,\s*\d+\s*,\s*"([a-z0-9_]+)"/g;

const catalogRaw = await readFile(catalogPath, "utf8");
const catalogJson = JSON.parse(catalogRaw);
const catalogEntries = Array.isArray(catalogJson.codes) ? catalogJson.codes : [];

const duplicateCatalogCodes = findDuplicates(catalogEntries.map((entry) => entry.code));
if (duplicateCatalogCodes.length > 0) {
  console.error(`Duplicate error codes in catalog: ${duplicateCatalogCodes.join(", ")}`);
  process.exit(1);
}

const catalogSet = new Set(catalogEntries.map((entry) => entry.code));
const sourceFiles = await listTypeScriptFiles(servicesDir);

const usedCodes = new Map();
for (const filePath of sourceFiles) {
  const source = await readFile(filePath, "utf8");
  const discovered = [
    ...extractMatches(source, codeLiteralPattern),
    ...extractMatches(source, sendErrorPattern),
    ...extractMatches(source, writeErrorPattern)
  ];
  for (const code of discovered) {
    const locations = usedCodes.get(code) ?? [];
    locations.push(path.relative(rootDir, filePath));
    usedCodes.set(code, locations);
  }
}

const unknownCodes = [...usedCodes.keys()].filter((code) => !catalogSet.has(code)).sort();
const unusedCatalogCodes = [...catalogSet].filter((code) => !usedCodes.has(code)).sort();

if (unknownCodes.length > 0 || unusedCatalogCodes.length > 0) {
  if (unknownCodes.length > 0) {
    console.error(`Unknown errorCode(s) not in config/error-codes.json: ${unknownCodes.join(", ")}`);
  }
  if (unusedCatalogCodes.length > 0) {
    console.error(`Catalog errorCode(s) not currently used in services: ${unusedCatalogCodes.join(", ")}`);
  }
  process.exit(1);
}

console.log(`Error code verification passed (${catalogSet.size} codes).`);

function extractMatches(source, regex) {
  const matches = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(source)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (!value || typeof value !== "string") continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

async function listTypeScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}
