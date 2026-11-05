import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { normalize, readJson } from '../scripts/build-data.mjs';
import { normalizePortraits } from '../scripts/portrait-data.mjs';
import { extractDataset } from '../scripts/sync.mjs';

const [pose, costume, zh, portrait, catalog, manifest, animeCostumes] = await Promise.all(
  [
    'data/source/pose.json',
    'data/source/costume.json',
    'data/source/pose-zh.json',
    'data/source/portrait.json',
    'public/data/catalog.json',
    'data/sync-manifest.json',
    'data/source/costume-anime.json',
  ].map(readJson),
);
const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
const { matchesQuery, sortItems, storageGet } = await vite.ssrLoadModule('/src/library.ts');
const { hasPoseDepth, withPoseDepth, poseDepthOrigin } =
  await vite.ssrLoadModule('/src/pose-depth.ts');
after(async () => {
  await vite.close();
});

test('all source records are preserved, uniquely grouped, with no invented angles', async () => {
  assert.deepEqual(await normalize(pose, costume, zh, portrait, animeCostumes), catalog);
  const poseGroups = catalog.items.filter(
    (item) => item.kind === 'pose' && item.collection !== 'custom',
  );
  assert.equal(
    poseGroups.reduce((sum, item) => sum + item.variants.length, 0),
    pose.length,
  );
  assert.equal(
    catalog.items.filter((item) => item.kind === 'costume' && item.collection !== 'custom').length,
    costume.length + animeCostumes.length,
  );
  assert.equal(new Set(catalog.items.map((item) => item.id)).size, catalog.items.length);
  assert.equal(
    catalog.stats.images,
    pose.length +
      costume.length +
      animeCostumes.length +
      portrait.length +
      catalog.items
        .filter((item) => item.collection === 'custom')
        .reduce((n, item) => n + item.variants.length, 0),
  );
  assert.deepEqual(
    new Set(poseGroups.flatMap((item) => item.variants.map((variant) => variant.id))),
    new Set(pose.map((row) => row.id)),
  );
});

test('every reference has complete Chinese and English, and upstream URLs stay unchanged', () => {
  for (const item of catalog.items) {
    for (const field of ['title', 'category', 'series', 'keywords']) {
      assert.ok(item[field].zh.length > 0, `${item.id} ${field}.zh`);
      assert.ok(item[field].en.length > 0, `${item.id} ${field}.en`);
      assert.doesNotMatch(item[field].en, /[\u3040-\u30ff\u4e00-\u9fff]/);
    }
    for (const variant of item.variants) {
      for (const key of item.collection === 'custom' ? [] : ['thumbnail', 'image', 'original']) {
        assert.equal(
          new URL(variant[key]).origin,
          item.kind === 'pose'
            ? 'https://ai-pose-gallery.pages.dev'
            : item.kind === 'costume'
              ? new URL(item.source).origin
              : 'https://ai-portrait-gallery.pages.dev',
        );
      }
      assert.ok(variant.label.zh && variant.label.en);
    }
  }
});

test('source snapshot hashes and counts match the crawl manifest', () => {
  for (const [index, rows] of [pose, costume, zh, portrait, animeCostumes].entries()) {
    assert.equal(manifest.sources[index].records, rows.length);
    assert.equal(
      manifest.sources[index].sha256,
      createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    );
  }
  assert.equal(manifest.imagesDownloaded, 0);
});

test('scraper treats source scripts as untrusted JSON and handles brackets in strings', () => {
  const data = [{ id: 'test', title: 'A ] bracket and a "quote"' }];
  assert.deepEqual(
    extractDataset(`<script>const D=${JSON.stringify(data)};doSomething()</script>`),
    data,
  );
  assert.throws(() => extractDataset('const D=[{ "id": "broken" }'));
  assert.throws(() => extractDataset('const D=(()=>{throw Error("execute")})()'));
  assert.throws(() => extractDataset('const OTHER=[]'));
});

test('search works in both languages, accepts joined Chinese clothing terms and intersects terms', () => {
  const coat = catalog.items.find(
    (item) =>
      item.kind === 'costume' &&
      item.keywords.en.includes('blue') &&
      item.keywords.en.includes('coat'),
  );
  assert.ok(coat);
  for (const query of [
    'blue coat',
    '蓝色 大衣',
    '蓝色大衣',
    '藍色 大衣',
    '藍色大衣',
    'BLUE COAT',
    coat.id.toLowerCase(),
    'blue 大衣',
  ])
    assert.ok(matchesQuery(coat, query), query);
  assert.ok(!matchesQuery(coat, 'blue not-a-real-garment'));
  assert.ok(
    matchesQuery(
      catalog.items.find((item) => item.id === 'full_single_P045'),
      'side sitting',
    ),
  );
  assert.ok(
    matchesQuery(
      catalog.items.find((item) => item.id === 'full_single_P045'),
      '侧坐',
    ),
  );
  assert.ok(
    matchesQuery(
      catalog.items.find((item) => item.id === 'full_single_P045'),
      '側坐',
    ),
  );
  assert.ok(matchesQuery(coat, ''));
});

test('all sort modes preserve every reference', () => {
  for (const mode of ['curated', 'name', 'code']) {
    const sorted = sortItems(catalog.items, mode, 'en');
    assert.equal(sorted.length, catalog.items.length);
    assert.equal(new Set(sorted.map((item) => item.id)).size, catalog.items.length);
  }
  assert.equal(sortItems(catalog.items, 'curated', 'en')[0].kind, 'pose');
  assert.equal(sortItems(catalog.items, 'curated', 'en')[1].kind, 'costume');
});

test('missing, damaged, or inaccessible local storage falls back safely', () => {
  const validator = (v) => Array.isArray(v) && v.every((id) => typeof id === 'string');
  globalThis.localStorage = { getItem: () => '{bad-json' };
  assert.deepEqual(storageGet('saved', [], validator), []);
  globalThis.localStorage = { getItem: () => JSON.stringify([42]) };
  assert.deepEqual(storageGet('saved', [], validator), []);
  globalThis.localStorage = {
    getItem: () => {
      throw Error('SecurityError');
    },
  };
  assert.deepEqual(storageGet('saved', [], validator), []);
  delete globalThis.localStorage;
});

test('portrait ingestion preserves both sections, translates styles and rejects unsafe or incomplete records', async () => {
  const characters = catalog.items.filter(
    (item) => item.kind === 'character' && item.collection !== 'custom',
  );
  assert.equal(characters.length, portrait.length);
  assert.equal(characters.filter((item) => item.portrait.section === 'face').length, 893);
  assert.equal(characters.filter((item) => item.portrait.section === 'styling').length, 606);
  assert.ok(
    matchesQuery(
      characters.find((item) => item.title.en.includes('Black short bob')),
      '黑色 螺旋',
    ),
  );
  assert.ok(
    matchesQuery(
      characters.find((item) => item.title.en.includes('Black short bob')),
      'black spiral',
    ),
  );
  for (const row of [
    { ...portrait[0], full: 'https://other.example/image.png' },
    { ...portrait[0], section: 'unknown' },
    { ...portrait[0], hair: 'unknown' },
    { ...portrait[0], style: 'unknown' },
  ])
    await assert.rejects(normalizePortraits([row]));
  await assert.rejects(normalizePortraits([portrait[0], portrait[0]]));
  assert.deepEqual(
    extractDataset(
      'window.GALLERY_IMAGES=[{"id":"safe"}];throw Error("untrusted");',
      /\bwindow\.GALLERY_IMAGES\s*=\s*/,
    ),
    [{ id: 'safe' }],
  );
});

test('depth mode preserves catalog identity and angles without mutating originals', () => {
  const snapshot = JSON.stringify(catalog);
  for (const item of catalog.items) {
    const depth = withPoseDepth(item);
    if (
      item.kind !== 'pose' ||
      (item.collection === 'custom' && !item.variants.every((v) => v.depth))
    ) {
      assert.equal(hasPoseDepth(item), false);
      assert.equal(depth, item);
      continue;
    }
    assert.equal(hasPoseDepth(item), true);
    assert.equal(hasPoseDepth(depth), true);
    assert.deepEqual({ ...depth, source: item.source, variants: item.variants }, item);
    assert.equal(depth.variants.length, item.variants.length);
    for (const [index, variant] of depth.variants.entries()) {
      const original = item.variants[index];
      assert.equal(variant.id, original.id);
      assert.equal(variant.angle, original.angle);
      assert.deepEqual(variant.label, original.label);
      for (const field of ['thumbnail', 'image', 'original']) {
        if (item.collection === 'custom') {
          assert.equal(variant[field], original.depth[field]);
          assert.equal(variant.depthMap, true);
          continue;
        }
        assert.equal(new URL(variant[field]).origin, poseDepthOrigin);
        assert.equal(new URL(variant[field]).pathname, new URL(original[field]).pathname);
      }
    }
  }
  assert.equal(JSON.stringify(catalog), snapshot);
});

test('catalog Chinese text uses Taiwan Traditional wording', async () => {
  const { toTaiwan } = await import('../scripts/zh-tw.mjs');
  for (const [simplified, taiwan] of [
    ['迷你连衣裙', '迷你洋裝'],
    ['蕾丝吊带衫', '蕾絲細肩帶上衣'],
    ['空气刘海', '空氣瀏海'],
    ['酒红色轻透层次发', '酒紅色輕透層次髮'],
    ['显示扩展分类', '顯示擴充分類'],
    ['酒红蕾丝吊带袜套装', '酒紅蕾絲吊帶襪套裝'],
  ])
    assert.equal(toTaiwan(simplified), taiwan);
  for (const text of ['攝影棚質感', '模特兒', '不加入文字或浮水印'])
    assert.equal(toTaiwan(text), text);
  const item = catalog.items.find((entry) => entry.id === 'full_single_P045');
  assert.equal(toTaiwan(item.title.zh), item.title.zh);
  assert.equal(toTaiwan(item.category.zh), item.category.zh);
});
