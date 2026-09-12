#!/usr/bin/env node
/**
 * demo-build.js: bundles setup/demos/<slug>/ into worker/src/demo/bundle.generated.js.
 *
 * Run from anywhere:  node scripts/demo-build.js
 * Runs automatically from `npm run dev` (worker/) and scripts/build-and-deploy.sh.
 *
 * For each folder in setup/demos/:
 *   demo.json          settings (see setup/examples/demos/example/demo.json)
 *   knowledge/*.md     facts the bot may use, joined in filename order
 *   logo.png|svg|webp  optional, embedded as a data URI (sent only after login)
 *
 * The password in demo.json is replaced in the bundle by a salted PBKDF2
 * hash, so the worker never holds the plain password. The bundle file is
 * gitignored: this repository is public and demo content is private.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT      = path.resolve(__dirname, '..');
const DEMOS_DIR = path.join(ROOT, 'setup', 'demos');
const OUT_FILE  = path.join(ROOT, 'worker', 'src', 'demo', 'bundle.generated.js');

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function fail(msg) { console.error(`  ERROR    ${msg}`); process.exit(1); }
function ok(msg)   { console.log(`  ok       ${msg}`); }
function warn(msg) { console.log(`  warn     ${msg}`); }

// Must match worker/src/demo/auth.js exactly, including the iteration count.
const PBKDF2_ITERATIONS = 210000;

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
}

function buildOne(dir, slug) {
  const configPath = path.join(dir, 'demo.json');
  if (!fs.existsSync(configPath)) fail(`${slug}: demo.json is missing.`);

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`${slug}: demo.json is not valid JSON (${e.message}).`);
  }

  if (!SLUG_PATTERN.test(slug)) fail(`${slug}: folder name must be lowercase letters, digits and hyphens.`);
  if (!cfg.business?.name) fail(`${slug}: business.name is required.`);
  if (typeof cfg.password !== 'string' || cfg.password.length < 12 || /replace-with/i.test(cfg.password)) {
    fail(`${slug}: password must be at least 12 characters and not the placeholder. Generate one with: node scripts/demo-build.js --password`);
  }

  // Knowledge files, in name order so numbering the files controls the order.
  const kDir = path.join(dir, 'knowledge');
  let knowledge = '';
  let files = 0;
  const sampleTopics = [];
  if (fs.existsSync(kDir)) {
    for (const f of fs.readdirSync(kDir).filter(n => n.endsWith('.md')).sort()) {
      let body = fs.readFileSync(path.join(kDir, f), 'utf8').trim();
      if (!body) continue;
      // Sample lines: "[SAMPLE: dogs, dog] Dogs: well behaved dogs are welcome".
      // The words after the colon are the topic keywords; if none are given,
      // the "Topic:" label at the start of the line is used. The worker uses
      // them to add an "example information" note whenever a reply touches
      // the topic, whether or not the model remembered to say so itself.
      body = body.replace(/\[SAMPLE(?::([^\]]*))?\]\s*([^:\n]{1,60}:)?/g, (m, kws, topic) => {
        const label    = (topic ?? '').replace(/:$/, '').trim() || 'this';
        const keywords = (kws ? kws.split(',') : [label])
          .map(w => w.trim().toLowerCase()).filter(Boolean);
        if (keywords.length) sampleTopics.push({ label: label.toLowerCase(), keywords });
        return `[SAMPLE: example only, not confirmed by ${cfg.business.name}; tell the visitor this is example information] ${topic ?? ''}`;
      });
      knowledge += `\n\n## ${f.replace(/^\d+[-_]?/, '').replace(/\.md$/, '')}\n\n${body}`;
      files += 1;
    }
  }
  if (!files) warn(`${slug}: no knowledge files found; the bot will have nothing to answer from.`);

  // Logo, embedded so it is only ever served after the password check.
  let logoDataUri = null;
  for (const ext of Object.keys(MIME)) {
    const p = path.join(dir, `logo${ext}`);
    if (fs.existsSync(p)) {
      const bytes = fs.readFileSync(p);
      if (bytes.length > 200 * 1024) warn(`${slug}: logo${ext} is ${Math.round(bytes.length / 1024)} KB; keep logos under 200 KB.`);
      logoDataUri = `data:${MIME[ext]};base64,${bytes.toString('base64')}`;
      break;
    }
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const { password, ...rest } = cfg;

  ok(`${slug}: ${files} knowledge file(s), ${knowledge.length} characters, ${sampleTopics.length} sample topic(s)${logoDataUri ? ', logo embedded' : ', no logo'}.`);

  return {
    ...rest,
    slug,
    passwordSalt: salt,
    passwordHash: hashPassword(password, salt),
    knowledge:    knowledge.trim(),
    sampleTopics,
    logoDataUri,
  };
}

function main() {
  if (process.argv.includes('--password')) {
    console.log(generatePassword());
    return;
  }

  const bundle = {};
  if (fs.existsSync(DEMOS_DIR)) {
    for (const slug of fs.readdirSync(DEMOS_DIR).sort()) {
      const dir = path.join(DEMOS_DIR, slug);
      if (!fs.statSync(dir).isDirectory() || slug.startsWith('.')) continue;
      bundle[slug] = buildOne(dir, slug);
    }
  }

  const count = Object.keys(bundle).length;
  const header =
    '// GENERATED by scripts/demo-build.js. Do not edit; do not commit.\n' +
    `// ${count} demo(s), built ${new Date().toISOString()}.\n`;
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${header}export default ${JSON.stringify(bundle, null, 2)};\n`);
  ok(`bundle written: ${path.relative(ROOT, OUT_FILE)} (${count} demo(s)).`);
  if (!count) warn('no demos in setup/demos/. Copy setup/examples/demos/example/ to start one.');
}

/* The owner is sent this once and pastes it, so it has to be unguessable
   rather than memorable.
     - Comfortably past 128 bits, the point where brute force stops being a
       threat at any hash speed. More would not make it safer, only longer
       to paste on a phone.
     - Alphabet drops i, l, o and u, the characters people misread or
       mishear if the password ever gets read down a phone.
     - Grouped in fives so a human can check it against the message.
   30 characters x log2(30) is 147 bits, in six clean groups of five. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const PASSWORD_LENGTH   = 30;

function generatePassword() {
  let out = '';
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    // randomInt is uniform over the range, so no modulo bias from 256 % 30.
    out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    if (i % 5 === 4 && i !== PASSWORD_LENGTH - 1) out += '-';
  }
  return out;
}

main();
