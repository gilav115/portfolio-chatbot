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
 * The password in demo.json is replaced in the bundle by a salted SHA-256
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

/* Five random words plus a two digit number, still easy to read down a phone.
   The list is 120 words, so the keyspace is 120^5 x 90, about 41 bits. The
   salted hash is baked into the deployed worker rather than served anywhere,
   and the hash is PBKDF2 with 210,000 rounds, so an offline attack on a leaked
   bundle is slow per guess as well. Four words from a 30 word list gave only
   26 bits against a plain SHA-256, which would not have held. */
const PASSWORD_WORDS = [
  'oven', 'spoon', 'river', 'lantern', 'maple', 'pebble', 'harbour', 'copper', 'meadow', 'cedar',
  'ember', 'orchard', 'saffron', 'willow', 'summit', 'velvet', 'marble', 'clover', 'north', 'ferry',
  'poppy', 'quartz', 'timber', 'garnet', 'linen', 'anchor', 'hazel', 'compass', 'barley', 'tide',
  'alder', 'amber', 'aspen', 'basil', 'beacon', 'birch', 'bramble', 'bridge', 'bronze', 'burrow',
  'canvas', 'cavern', 'chalk', 'cinder', 'cobble', 'copse', 'cotton', 'cove', 'cressy', 'crimson',
  'damson', 'dune', 'elder', 'fathom', 'fennel', 'flint', 'forge', 'gable', 'ginger', 'granite',
  'grove', 'gully', 'harvest', 'heath', 'hollow', 'indigo', 'ivory', 'juniper', 'kettle', 'lagoon',
  'lattice', 'ledger', 'lichen', 'lilac', 'lumber', 'mallow', 'mantle', 'marsh', 'mica', 'millet',
  'mortar', 'nettle', 'nutmeg', 'oakum', 'onyx', 'osprey', 'parsley', 'pewter', 'pilot', 'plover',
  'pollen', 'pumice', 'quarry', 'quince', 'rafter', 'reed', 'rosin', 'rowan', 'rudder', 'rushes',
  'sable', 'sandbar', 'sedge', 'shale', 'sorrel', 'spelt', 'spindle', 'sterling', 'stipple', 'sumac',
  'tallow', 'tamarind', 'teasel', 'thistle', 'thrush', 'tinder', 'trellis', 'vellum', 'walnut', 'yarrow',
];

function generatePassword() {
  const pick = () => PASSWORD_WORDS[crypto.randomInt(PASSWORD_WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${pick()}-${pick()}-${crypto.randomInt(10, 100)}`;
}

main();
