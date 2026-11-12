#!/usr/bin/env node
/**
 * firmware-lint — static checks for the uniform Programmable Block script.
 *
 * This is not a compiler. It catches the two failure modes that cost the most
 * time in game: exceeding the PB size limit, and referencing APIs the sandbox
 * does not allow. Run it before pasting firmware into a PB.
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MAX_CHARS = 100_000;

export const FORBIDDEN = [
  { pattern: /\bSystem\.Net\b/, reason: 'PB sandbox has no network APIs' },
  { pattern: /\bSystem\.IO\b/, reason: 'PB sandbox has no file system' },
  { pattern: /\bSystem\.Reflection\b/, reason: 'reflection is not allowed in the sandbox' },
  { pattern: /\bSystem\.Runtime\.InteropServices\b/, reason: 'P/Invoke is not allowed' },
  { pattern: /\bSystem\.Diagnostics\b/, reason: 'process/diagnostics APIs are not allowed' },
  { pattern: /\bMicrosoft\.Win32\b/, reason: 'Windows registry APIs are not allowed' },
  { pattern: /\bSystem\.Security\b/, reason: 'cryptography/security APIs are not allowed' },
  { pattern: /\bDllImport\b/, reason: 'P/Invoke is not allowed' },
  { pattern: /\bEnvironment\.Exit\b/, reason: 'scripts must return from Main, not exit' },
];

export const REQUIRED = [
  { pattern: /\bconst\s+string\s+FIRMWARE_VERSION\s*=/, reason: 'FIRMWARE_VERSION constant is required' },
  { pattern: /\bpublic\s+void\s+Main\s*\(\s*string\s+argument/, reason: 'public void Main(string argument, UpdateType ...) is required' },
  { pattern: /\bpublic\s+void\s+Save\s*\(\s*\)/, reason: 'public void Save() is required' },
  { pattern: /\bpublic\s+Program\s*\(\s*\)/, reason: 'public Program() is required' },
];

/**
 * @param {string} source
 * @returns {{ok:boolean, errors:string[], warnings:string[], stats:{chars:number, lines:number, maxChars:number}}}
 */
export function lintFirmware(source) {
  const errors = [];
  const warnings = [];
  const text = String(source ?? '');
  const chars = text.length;
  const lines = text.split('\n').length;

  if (chars === 0) errors.push('firmware is empty');
  if (chars > MAX_CHARS) {
    errors.push(`firmware is ${chars} chars, over the ${MAX_CHARS} limit by ${chars - MAX_CHARS}`);
  }

  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(text)) errors.push(`forbidden API: ${rule.reason} (${rule.pattern})`);
  }

  for (const rule of REQUIRED) {
    if (!rule.pattern.test(text)) errors.push(`missing: ${rule.reason}`);
  }

  if (/\bwhile\s*\(\s*true\s*\)/.test(text)) {
    warnings.push('unbounded while(true) found; PB scripts must yield every tick');
  }
  if (text.includes('Thread.Sleep')) {
    warnings.push('Thread.Sleep blocks the simulation thread');
  }
  if (/\bnew\s+Random\s*\(\s*\)/.test(text)) {
    warnings.push('unseeded Random makes test results non-reproducible');
  }

  return { ok: errors.length === 0, errors, warnings, stats: { chars, lines, maxChars: MAX_CHARS } };
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter((a) => !a.startsWith('--'));
  const targets = paths.length > 0 ? paths : ['firmware/HermesFirmware.cs'];

  let failed = false;
  const results = [];

  for (const path of targets) {
    if (!existsSync(path)) {
      results.push({ path, ok: false, errors: [`file not found: ${path}`], warnings: [], stats: null });
      failed = true;
      continue;
    }
    const result = lintFirmware(readFileSync(path, 'utf8'));
    results.push({ path, ...result });
    if (!result.ok) failed = true;
  }

  if (json) {
    console.log(JSON.stringify({ ok: !failed, results }, null, 2));
  } else {
    for (const r of results) {
      const stat = r.stats ? `${r.stats.chars}/${r.stats.maxChars} chars, ${r.stats.lines} lines` : 'n/a';
      console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.path} (${stat})`);
      for (const e of r.errors) console.log(`  error: ${e}`);
      for (const w of r.warnings) console.log(`  warn:  ${w}`);
    }
  }

  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
