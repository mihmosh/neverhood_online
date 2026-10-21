#!/usr/bin/env python3
"""Offline generator tests; --smoke also checks the actual private run in Chrome."""
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import copy

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('manual_review', ROOT / 'tools/upscaling/gemini/manual-review.py')
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)
RUN = ROOT / 'private-assets/upscaling/gemini-experiments/opaque-all-v1'


class ManualReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/tmp/kilo')
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name) / 'private-assets' / 'run'
        self.run.mkdir(parents=True)
        source = self.run / 'source.png'
        source.write_bytes(b'fixture-source')
        output = self.run / 'output.png'
        output.write_bytes(b'fixture-output')
        def meta(p):
            return {'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'dimensions': [640, 480]}
        rooms = [{'id': f'Scene{i}', 'resourceId': f'0x{i:08X}', 'source': meta(source),
                  'bindingAliases': []} for i in range(42)]
        self.manifest = {'rooms': rooms, 'experimentId': 'test'}
        self.check = {'rooms': [{'id': r['id'], 'entries': [{'id': r['id']+'-candidate',
                       'origin': 'generation' if i < 30 else 'reused', 'source': meta(source),
                       'output': meta(output) if i < 40 else None}]} for i, r in enumerate(rooms)]}
        self.flush()

    def flush(self):
        path = self.run / 'experiment.json'
        path.write_text(json.dumps(self.manifest))
        self.check['manifest'] = {'sha256': REVIEW.sha256(path)}
        (self.run / 'bulk-check.json').write_text(json.dumps(self.check))

    def test_coverage_and_no_initial_approval(self):
        data = REVIEW.build_data(self.run)
        self.assertEqual(len(data['rooms']), 42)
        self.assertEqual(sum(r['available'] for r in data['rooms']), 40)
        self.assertEqual(sum(r['origin'] == 'new' for r in data['rooms']), 30)
        for room in data['rooms']:
            self.assertNotIn('decision', room)
            self.assertEqual(room['canApprove'], room['available'])
            for image in (room['source'], room['output']):
                if image:
                    self.assertTrue((self.run / image['url']).resolve().is_relative_to(self.run.parent))

    def test_script_escaping_and_no_external_urls(self):
        self.manifest['rooms'][0]['label'] = '</script><img src=x onerror=alert(1)>&'
        self.flush()
        html = REVIEW.render(REVIEW.build_data(self.run))
        self.assertNotIn('</script><img', html)
        self.assertIn(r'\u003c/script\u003e', html)
        self.assertNotRegex(html, r'https?://|<script[^>]+src=|<link[^>]+href=')
        self.assertIn("connect-src 'none'", html)
        self.assertIn("img.loading='lazy'", html)

    def test_stale_manifest_rejected(self):
        (self.run / 'experiment.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'manifest hash'):
            REVIEW.build_data(self.run)

    def test_source_and_output_hashes_checked(self):
        for name in ('source.png', 'output.png'):
            with self.subTest(name=name):
                path = self.run / name
                original = path.read_bytes()
                path.write_bytes(b'tampered')
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    REVIEW.build_data(self.run)
                path.write_bytes(original)

    def test_private_boundary(self):
        self.check['rooms'][0]['entries'][0]['output']['path'] = '/etc/passwd'
        self.flush()
        with self.assertRaisesRegex(ValueError, 'escapes private-assets'):
            REVIEW.build_data(self.run)

    def test_missing_room_rejected(self):
        self.check['rooms'].pop()
        self.flush()
        with self.assertRaisesRegex(ValueError, 'coverage mismatch'):
            REVIEW.build_data(self.run)

    def test_cli_private_permissions(self):
        subprocess.run([sys.executable, str(Path(REVIEW.__file__)), str(self.run)], check=True, capture_output=True)
        for name in ('review.html', 'manual-review-data.json'):
            self.assertEqual(stat.S_IMODE((self.run / name).stat().st_mode), 0o600)
        before = (self.run / 'review.html').read_bytes()
        result = subprocess.run([sys.executable, str(Path(REVIEW.__file__)), str(self.run)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.run / 'review.html').read_bytes(), before)

    def test_multiple_versions_unknown_does_not_hide_retry(self):
        entries = self.check['rooms'][0]['entries']
        old = entries[0]
        old['origin'] = 'reused'
        retry = copy.deepcopy(old)
        retry.update(id='retry-attempt-2', origin='generation')
        old['output'] = None
        entries.append(retry)
        self.flush()
        data = REVIEW.build_data(self.run)
        versions = [r for r in data['rooms'] if r['roomId'] == 'Scene0']
        self.assertEqual(len(versions), 2)
        self.assertEqual(versions[0]['candidateId'], 'retry-attempt-2')
        self.assertTrue(versions[0]['canApprove'])
        self.assertTrue(versions[0]['label'].endswith('/ v2'))
        self.assertTrue(versions[1]['label'].endswith('/ v1'))
        self.assertFalse(versions[1]['canApprove'])
        self.assertNotEqual(versions[0]['id'], versions[1]['id'])
        self.assertEqual(versions[0]['artifactId'], versions[0]['source']['sha256'] + ':' + versions[0]['output']['sha256'])

    def test_js_per_artifact_migration_never_approves_new_revision(self):
        data = REVIEW.build_data(self.run)
        old = data['rooms'][0]
        old['artifactId'] = 'source:old'
        old['source']['sha256'] = 'source'
        old['output']['sha256'] = 'old'
        new = copy.deepcopy(old)
        new.update(id='new-version', candidateId='attempt2', artifactId='source:new')
        new['output']['sha256'] = 'new'
        data['rooms'] = [new, old]
        script = REVIEW.HTML.split("'use strict';", 1)[1].split('function save()', 1)[0]
        prelude = 'const assert=require("node:assert/strict"); const document={getElementById:()=>({textContent:'+json.dumps(json.dumps(data))+'})};\n'
        checks = r'''
const priorIdentity={...identity(D.rooms[1]),id:'Scene0',candidateId:'prior-job'};
const prior={schemaVersion:1,manifestSha256:'old-manifest',candidates:[priorIdentity],decisions:[{...priorIdentity,decision:'approved',notes:'original decision'}]};
assert.throws(()=>validate(prior));
const migrated=validate(prior,true);
assert.equal(migrated['source:old'].decision,'approved');
assert.equal(migrated['source:new'],undefined);
decisions=migrated;
assert.equal(status(D.rooms[0]),'pending');
assert.equal(status(D.rooms[1]),'approved');
assert.equal(validate(envelope())['source:old'].notes,'original decision');
const tampered=JSON.parse(JSON.stringify(prior));tampered.decisions[0].outputSha256='new';
assert.throws(()=>validate(tampered,true));
const stale=envelope();stale.decisions[0].outputSha256='old';assert.throws(()=>validate(stale));
'''
        result = subprocess.run(['node', '-e', prelude + script + checks], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_entire_browser_script_parses(self):
        script = REVIEW.HTML.split("<script>\n", 1)[1].split('</script>', 1)[0]
        result = subprocess.run(['node', '--check'], input=script, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_english_interface_and_human_aliases(self):
        self.manifest['rooms'][0]['id'] = 'Scene2810'
        self.check['rooms'][0]['id'] = 'Scene2810'
        self.manifest['rooms'][1].update(id='Module1000', aliases=['StaticScene'])
        self.check['rooms'][1]['id'] = 'Module1000'
        self.flush()
        data = REVIEW.build_data(self.run)
        self.assertEqual(data['rooms'][0]['label'], 'Hall of Fame / Statue Hall (Scene2810)')
        self.assertIn('StaticScene · window view (existing Module1000 binding)', data['rooms'][1]['aliases'])
        self.assertNotRegex(REVIEW.HTML, r'[\u0400-\u04ff]')
        self.assertIn('<html lang="en">', REVIEW.render(data))

    def test_optional_aggregator_fields_preserved_without_identity_changes(self):
        data = REVIEW.build_data(self.run)
        row = data['rooms'][0]
        identity = {k: copy.deepcopy(row[k]) for k in ('roomId', 'artifactId', 'source', 'output')}
        row.update(category='paired-experiment', canApprove=False,
                   additionalSources=[{'label': 'Original source B', 'meta': copy.deepcopy(row['source'])}],
                   startedAt='2026-10-21T12:00:00Z')
        data.update(relatedReviews=[], exclusions=[], coverageNote='All saved images.')
        html = REVIEW.render(data)
        encoded = html.split('<script id="review-data" type="application/json">', 1)[1].split('</script>', 1)[0]
        decoded = json.loads(encoded)
        self.assertEqual(decoded, data)
        self.assertEqual(decoded['schemaVersion'], 2)
        self.assertEqual({k: decoded['rooms'][0][k] for k in identity}, identity)
        self.assertFalse(decoded['rooms'][0]['canApprove'])

    def test_js_migration_preserves_old_notes_and_rejects_experiment_approval(self):
        data = REVIEW.build_data(self.run)
        data['rooms'] = data['rooms'][:1]
        script = REVIEW.HTML.split("'use strict';", 1)[1].split('function save()', 1)[0]
        prelude = 'const assert=require("node:assert/strict"); const document={getElementById:()=>({textContent:'+json.dumps(json.dumps(data))+'})};\n'
        checks = r'''
for(const schemaVersion of [1,2]){
 const item={...identity(D.rooms[0]),id:'legacy-id',candidateId:'legacy-candidate'};
 const notes=String.fromCodePoint(0x41f,0x440,0x438,0x43d,0x44f,0x442,0x43e);
 const prior={schemaVersion,manifestSha256:'legacy',candidates:[item],decisions:[{...item,decision:'approved',notes}]};
 assert.equal(validate(prior,true)[decisionKey(D.rooms[0])].notes,notes);
 D.rooms[0].canApprove=false;
 assert.throws(()=>validate(prior,true),/Invalid artifact approval/);
 prior.decisions[0].decision='rework';
 assert.equal(validate(prior,true)[decisionKey(D.rooms[0])].decision,'rework');
 D.rooms[0].canApprove=true;
}
assert.equal(timestamp({startedAt:'2026-10-21T12:00:00Z'}),'2026-10-21 12:00:00 UTC');
assert.equal(timestamp({}),'');
'''
        result = subprocess.run(['node', '-e', prelude + script + checks], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_js_category_search_sources_and_manual_experiment_decisions(self):
        data = REVIEW.build_data(self.run)
        pair, first, second = copy.deepcopy(data['rooms'][:3])
        pair.update(roomId='paired-experiment', category='paired-experiment', canApprove=False,
                    label='Lighting experiment', artifactId='source:paired-output',
                    additionalSources=[{'label': 'Original source B',
                                        'meta': {'url': 'source-b.png', 'sha256': 'source-b', 'dimensions': [640, 480]}}])
        pair['output'].update(url='pair-output.png', sha256='paired-output')
        first.update(category='production', startedAt='2026-10-21T12:00:00Z')
        second.update(roomId=first['roomId'], category='production')
        second['output'].update(url='older-output.png', sha256='older-output')
        second['artifactId'] = second['source']['sha256'] + ':older-output'
        data.update(rooms=[pair, first, second], relatedReviews=[], exclusions=[], coverageNote='All saved images.')
        script = REVIEW.HTML.split('<script>\n', 1)[1].split('</script>', 1)[0]
        prelude = r'''
const assert=require('node:assert/strict'), imageRequests=[];
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.hidden=false;this.complete=true;this.naturalWidth=1;this.classList={toggle(){}}}
 append(...children){this.children.push(...children)}
 replaceChildren(){this.children=[]}
 setAttribute(k,v){this.attrs[k]=v}
 getAttribute(k){return this.attrs[k]??null}
 removeAttribute(k){delete this.attrs[k]}
 set src(value){this.attrs.src=value;imageRequests.push(value)}
 get src(){return this.attrs.src}
 get options(){return this.children}
 get selectedOptions(){return this.children.filter(c=>c.value===this.value)}
}
const elements=new Map(),document={getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id)},createElement:tag=>new Element(tag),querySelectorAll:()=>[]};
const localStorage={getItem:()=>null,setItem(){}};
for(const id of ['filter','origin','category'])document.getElementById(id).value='all';
'''
        prelude += 'document.getElementById("review-data").textContent='+json.dumps(json.dumps(data))+';\n'
        checks = r'''
assert.equal($('categoryLabel').hidden,false);
assert.equal($('compareVersion').options.length,2,'One paired output with two original sources, not two candidate outputs');
assert.equal($('imageA').src,D.rooms[0].source.url);
assert.equal($('imageB').src,'pair-output.png');
assert(!imageRequests.includes('older-output.png'),'Inactive outputs are not loaded');
assert.equal($('approve').disabled,true);
assert.equal($('rework').disabled,false);
assert.equal($('experimentWarning').hidden,false);
assert.match($('experimentWarning').textContent,/cannot be approved as a room/);
assert.equal(status(D.rooms[0]),'pending');
decide('approved');assert.equal(status(D.rooms[0]),'pending');
$('notes').value='Manual experiment notes';$('notes').oninput();decide('rework');
assert.equal(status(D.rooms[0]),'rework');
assert.equal(envelope().decisions[0].notes,'Manual experiment notes');
assert.equal(validate(envelope())[decisionKey(D.rooms[0])].decision,'rework');
$('compareVersion').value='source:1';$('compareVersion').onchange();
assert.equal($('imageA').src,'source-b.png');
assert.equal($('imageB').src,'pair-output.png');
$('imageA').onerror();assert.equal($('missingSource').hidden,false);
assert.match($('missingSource').textContent,/Source image could not be loaded/);
assert.equal($('missing').hidden,true,'Broken source does not imply missing output');
assert.equal($('approve').disabled,true,'Image load state never grants experiment approval');
$('imageA').onload();assert.equal($('missingSource').hidden,true);
$('category').value='production';$('category').onchange();
assert.equal(visible().length,2);assert.equal(selected,D.rooms[1].id);
assert.equal($('compareVersion').value,'source','Changing candidates resets source selection');
assert.equal($('compareVersion').options.length,2,'Other candidate version is selectable');
$('compareVersion').value=D.rooms[2].id;$('compareVersion').onchange();
assert.equal($('imageA').src,'older-output.png');
assert.equal($('imageB').src,D.rooms[1].output.url);
$('search').value=D.rooms[1].candidateId;$('search').oninput();assert.equal(visible().length,1);
$('search').value='no-such-candidate';$('search').oninput();assert.equal(visible().length,0);
'''
        result = subprocess.run(['node', '-e', prelude + script + checks], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless((RUN / 'bulk-check.json').exists(), 'Private actual run not present')
    def test_actual_42_room_coverage(self):
        data = REVIEW.build_data(RUN)
        self.assertEqual(len(data['rooms']), 42)
        self.assertEqual(sum(r['available'] for r in data['rooms']), 40)
        module = next(r for r in data['rooms'] if r['id'] == 'Module1000')
        self.assertTrue(any('StaticScene' in a for a in module['aliases']))


SMOKE = r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),{pathToFileURL}=require('node:url');
const {chromium}=require('/tmp/kilo/node_modules/playwright');
(async()=>{
 const run=process.argv[1], data=JSON.parse(fs.readFileSync(run+'/manual-review-data.json','utf8'));
 const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
 try{
  await page.goto(pathToFileURL(run+'/review.html').href);
  await page.evaluate(()=>localStorage.clear());await page.reload();
  const loaded=async()=>{await page.waitForFunction(()=>['imageA','imageB'].every(id=>{const i=document.getElementById(id);return i.hidden||(i.complete&&i.naturalWidth>0)}))};
  await loaded();assert.equal(await page.locator('.room').count(),42);
   assert.equal(await page.locator('#summary').textContent(),'40 / 42 scenes or experiments with output · 40 versions · 0 approved · 0 need rework');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(new Set(requests.filter(u=>data.rooms.some(r=>r.output&&u.endsWith(r.output.url)))).size,1,'Only active 2K candidate requested across reload');
  assert(!requests.some(u=>/^https?:/.test(u)),'No network requests');
  await page.locator('[data-mode=a]').click();assert(await page.locator('#figureB').isHidden());
  await page.locator('[data-mode=b]').click();assert(await page.locator('#figureA').isHidden());
  await page.locator('#imageB').click();assert(await page.locator('#zoom').isVisible());
  await page.locator('#closeZoom').click();await page.locator('[data-mode=pair]').click();
   await page.locator('#notes').fill('Review: geometry and details');await page.locator('#approve').click();
   await page.reload();await loaded();assert.equal(await page.locator('#notes').inputValue(),'Review: geometry and details');
   assert.equal(await page.locator('#decisionStatus').textContent(),'Manually approved');
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);
  const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(exported.manifestSha256,data.manifestSha256);assert.equal(exported.decisions.length,42);
   assert.equal(exported.decisions[0].decision,'approved');assert.equal(exported.decisions[0].notes,'Review: geometry and details');
  const upload=async doc=>page.locator('#importFile').setInputFiles({name:'review.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
   await upload({...exported,manifestSha256:'0'.repeat(64)});await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('rejected'));
   assert.equal(await page.locator('#decisionStatus').textContent(),'Manually approved');
  const stale=structuredClone(exported);stale.decisions[0].outputSha256='0'.repeat(64);await upload(stale);
   await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Stale'));
  const staleCandidate=structuredClone(exported);staleCandidate.candidates[0].sourceSha256='0'.repeat(64);await upload(staleCandidate);
   await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Candidate hashes'));
  const invalid=structuredClone(exported);invalid.decisions.find(d=>d.outputSha256===null).decision='approved';await upload(invalid);
   await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Invalid candidate'));
  await page.locator('#rework').click();
  await page.locator('#filter').selectOption('rework');assert.equal(await page.locator('.room').count(),1);
  await page.locator('#filter').selectOption('all');await upload(exported);
   await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Import validated'));
   assert.equal(await page.locator('#decisionStatus').textContent(),'Manually approved');
  await page.locator('#filter').selectOption('approved');assert.equal(await page.locator('.room').count(),1);
   await page.locator('#filter').selectOption('all');await page.locator('#defer').click();assert.equal(await page.locator('#decisionStatus').textContent(),'Pending review');
  await page.locator('#filter').selectOption('pending');assert.equal(await page.locator('.room').count(),40);
  await page.locator('#filter').selectOption('unavailable');assert.equal(await page.locator('.room').count(),2);
  assert(await page.locator('#approve').isDisabled());assert(await page.locator('#rework').isDisabled());assert(await page.locator('#missing').isVisible());
  await page.locator('#filter').selectOption('all');await page.locator('.room').first().click();
  await page.locator('#origin').selectOption('new');assert.equal(await page.locator('.room').count(),30);
  await page.locator('#origin').selectOption('historical');assert.equal(await page.locator('.room').count(),12);
  await page.locator('#origin').selectOption('all');
  for(const r of data.rooms){
   await page.locator('.room').evaluateAll((buttons,id)=>buttons.find(b=>b.dataset.room===id).click(),r.id);
   await loaded();
   assert.equal(await page.locator('#imageB').isVisible(),r.available,r.id);
   assert.equal(await page.locator('#approve').isDisabled(),!r.canApprove,r.id);
  }
  await page.locator('.room').first().click();await loaded();
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
   await page.setViewportSize({width,height});await loaded();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflow');
   assert(await page.locator('#imageA').isVisible());assert(await page.locator('#imageB').isVisible());
   for(const mode of ['a','b','pair'])await page.locator('[data-mode='+mode+']').click();
   await page.evaluate(()=>localStorage.clear());await page.reload();await loaded();
   const path=run+'/manual-review-'+name+'.png';await page.screenshot({path,fullPage:true});fs.chmodSync(path,0o600);
  }
   assert.equal(await page.locator('#notes').inputValue(),'');assert.equal(await page.locator('#decisionStatus').textContent(),'Pending review');
  assert.equal(await page.evaluate(()=>localStorage.length),0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({desktop:'1440x1000',mobile:'390x844',coverage:42,available:40,errors,checks:'images, single active candidate, A/B, zoom, persistence, filters, export, strict import, unavailable disabled, clean storage',screenshots:'private actual run only'}));
 }finally{await page.evaluate(()=>localStorage.clear()).catch(()=>{});await page.reload().catch(()=>{});await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
'''


if __name__ == '__main__':
    smoke = '--smoke' in sys.argv
    if smoke:
        sys.argv.remove('--smoke')
    result = unittest.main(exit=False)
    if not result.result.wasSuccessful():
        sys.exit(1)
    if smoke:
        subprocess.run(['node', '-e', SMOKE, str(RUN)], check=True)
