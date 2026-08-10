/* Bundle the ES modules + the demo clip into one self-contained index.html.
   No toolchain: the module set is small and hand-ordered, which is honest
   for a study project and keeps the artefact inspectable. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
// Dependency order, hand-maintained. Add new modules BEFORE app.js.
const ORDER = ['geom.js', 'detect.js', 'mp4.js', 'decoder.js', 'track.js',
               'analyse.js', 'charts.js', 'timeline.js', 'app.js'];

const strip = src => src
  .replace(/^import\s+[\s\S]*?from\s+'[^']+';[ \t]*$/gm, '')
  .replace(/^export\s+(?=(const|let|var|function|async function|class))/gm, '');

const parts = ORDER.map(f => ({ f, src: strip(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')) }));

// Concatenating modules flattens them into one scope, so two files that each
// declare `const css` become a SyntaxError that only shows up at runtime.
// Catch it here instead.
const seen = new Map(), dupes = [];
for (const { f, src } of parts) {
  for (const m of src.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = m[1];
    if (seen.has(name)) dupes.push(`${name} (${seen.get(name)} and ${f})`);
    else seen.set(name, f);
  }
}
if (dupes.length) {
  console.error('Top-level name collisions would break the bundle:\n  ' + dupes.join('\n  '));
  process.exit(1);
}

const body = parts.map(({ f, src }) =>
  `\n/* ======================= ${f} ======================= */\n` + src).join('\n');

// These are exact-text swaps against hand-maintained source strings: reformat the
// matched line in app.js/index.html and the replacement silently stops firing, shipping
// a build that looks fine but is broken (e.g. a relative fetch('fixtures/…') that fails
// from file://, which is the one scenario this bundle exists for). Assert each one hit.
const replaceOnce = (str, search, replacement, what) => {
  const out = str.replace(search, replacement);
  if (out === str) throw new Error(`build: "${what}" substitution did not match — source text moved`);
  return out;
};

const demo = fs.readFileSync(path.join(ROOT, 'fixtures/stroke_vp9.mp4')).toString('base64');
const bundled = replaceOnce(body,
  "const DEMO_URL = 'fixtures/stroke_vp9.mp4';",
  `const DEMO_URL = 'data:video/mp4;base64,${demo}';`, 'DEMO_URL');

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = replaceOnce(html, '<script type="module" src="src/app.js"></script>',
  `<script type="module">\n${bundled}\n</script>`, 'app.js script tag');
// The single file has no sibling manifest/sw/icons.
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '')
           .replace(/<link rel="icon"[^>]*>\n?/, '')
           .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '');
html = replaceOnce(html,
  "if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {\n  navigator.serviceWorker.register('sw.js').catch(() => {});\n}",
  '/* single-file build: no service worker */', 'service worker registration');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/puttlab-pro.html'), html);
console.log(`dist/puttlab-pro.html  ${(html.length / 1024).toFixed(0)} KB (demo clip inlined)`);
