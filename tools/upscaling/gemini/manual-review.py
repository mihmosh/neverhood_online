#!/usr/bin/env python3
"""Build a private, offline manual review workbench; never changes image bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import quote


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def build_data(run):
    run = Path(run).resolve()
    private = next((p for p in run.parents if p.name == 'private-assets'), None)
    if private is None:
        raise ValueError('Run must be inside private-assets')
    manifest_path = run / 'experiment.json'
    manifest = json.loads(manifest_path.read_text())
    check = json.loads((run / 'bulk-check.json').read_text())
    manifest_hash = sha256(manifest_path)
    if check['manifest']['sha256'] != manifest_hash:
        raise ValueError('Checker manifest hash is stale')

    def image(meta):
        if not meta or not meta.get('path'):
            return None
        path = Path(meta['path']).resolve()
        if not path.is_relative_to(private):
            raise ValueError('Image path escapes private-assets')
        actual = sha256(path)
        if actual != meta['sha256']:
            raise ValueError(f'Image hash mismatch: {path}')
        return {'url': quote(os.path.relpath(path, run), safe='/'),
                'sha256': actual, 'dimensions': meta.get('dimensions', [])}

    checked = {r['id']: r for r in check['rooms']}
    if len(checked) != len(manifest['rooms']) or set(checked) != {r['id'] for r in manifest['rooms']}:
        raise ValueError('Manifest/checker room coverage mismatch')
    rooms = []
    for room in manifest['rooms']:
        entries = checked[room['id']]['entries']
        if not entries:
            raise ValueError('Checker room has no candidate or unavailable placeholder')
        aliases = [a for a in room.get('aliases', []) if isinstance(a, str)]
        for alias in room.get('bindingAliases', []):
            text = ' · '.join(str(alias[k]) for k in ('scene', 'method', 'resourceId', 'bindingId') if alias.get(k))
            if 'createStaticScene' in alias.get('codeBinding', {}).get('excerpt', ''):
                text += ' · StaticScene'
            aliases.append(text)
        label = room.get('label') or room['id']
        if room['id'] == 'Scene2810':
            label = 'Hall of Fame / Statue Hall (Scene2810)'
        if room['id'] == 'Module1000' and any('StaticScene' in a for a in aliases):
            aliases.append('StaticScene · window view (existing Module1000 binding)')
        # New attempts are displayed first; no version inherits another's decision.
        chronological = sorted(enumerate(entries), key=lambda pair: (
            pair[1]['origin'] == 'generation', pair[1].get('startedAt') or '', pair[0]))
        versions = {index: version for version, (index, _) in enumerate(chronological, 1)}
        ordered = reversed(chronological)
        for index, entry in ordered:
            source = image(entry.get('source') or room.get('source'))
            output = image(entry.get('output'))
            artifact_id = source['sha256'] + ':' + output['sha256'] if source and output else None
            rooms.append({'id': room['id'] if len(entries) == 1 else room['id'] + '::' + str(index),
                       'roomId': room['id'], 'artifactId': artifact_id,
                        'label': label + (f' / v{versions[index]}' if len(entries) > 1 else ''), 'resourceId': room.get('resourceId', ''),
                        'aliases': aliases, 'candidateId': entry['id'], 'startedAt': entry.get('startedAt'),
                        'origin': 'new' if entry['origin'] == 'generation' else 'historical',
                        'source': source, 'output': output, 'available': output is not None,
                       'canApprove': source is not None and output is not None and entry.get('imageStatus', 'valid') == 'valid', 'status': entry.get('status'),
                       'technicalStatus': entry.get('technicalStatus', 'unavailable'),
                       'provenanceStatus': entry.get('provenanceStatus', 'unknown'),
                       'visualReviewStatus': entry.get('visualReviewStatus', 'manual-review-required'),
                       'observedStatus': entry.get('observedStatus'), 'issues': entry.get('issues', [])})
    registry = manifest.get('sourceRegistry', {})
    exclusions = [{k: d.get(k) for k in ('id', 'scene', 'resourceId', 'disposition', 'reason')}
                  for d in registry.get('dispositions', [])
                  if d.get('disposition', '').startswith(('excluded', 'unresolved'))]
    links = []
    for sibling, title in [('opaque-repair-v1', 'Previous review: 112 views and states'),
                           ('opaque-all-v1', 'Previous review: original versions and decisions'),
                           ('paired-lighting-v1', 'Paired experiment: lights on / off')]:
        page = run.parent / sibling / ('report.html' if sibling == 'paired-lighting-v1' else 'review.html')
        if page.exists() and page.parent != run:
            links.append({'url': quote(os.path.relpath(page, run), safe='/'), 'title': title})
    if (run / 'coverage-review.html').exists():
        links.append({'url': 'coverage-review.html', 'title': 'Coverage: originals not submitted for generation'})
    return {'schemaVersion': 2, 'private': True, 'manifestSha256': manifest_hash,
            'experimentId': manifest.get('experimentId', run.name), 'rooms': rooms,
            'relatedReviews': links,
            'exclusions': exclusions, 'coverageNote': registry.get('coverage', {}).get('note', '')}


def render(data):
    # JSON script data must not be able to terminate its HTML element.
    encoded = json.dumps(data, ensure_ascii=True).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    return HTML.replace('__REVIEW_DATA__', encoded)


HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Neverhood / Manual Review</title>
<style>
:root{color-scheme:dark;--bg:#151817;--panel:#1e2320;--line:#384139;--ink:#e7e9df;--muted:#a6afa3;--accent:#d1dc89;--warn:#e1b482}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px 'Trebuchet MS',Verdana,sans-serif}button,select,textarea,input{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:3px}button,select{padding:9px 12px}button,a,summary{cursor:pointer}button:hover:not(:disabled),button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}button:disabled{opacity:.35;cursor:not-allowed}a{color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}header{padding:22px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:18px;align-items:center}.eyebrow{font:11px 'Courier New',monospace;letter-spacing:.15em;color:var(--accent)}h1{font:26px Georgia,serif;font-weight:normal;margin:7px 0}h2{font:24px Georgia,serif;margin:0 0 8px}p{line-height:1.55;margin:8px 0}.muted,small{color:var(--muted)}.summary{font:13px 'Courier New',monospace}.toolbar{display:flex;gap:8px;flex-wrap:wrap}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:75vh}aside{border-right:1px solid var(--line);padding:16px 12px}aside label{display:block;font-size:12px;color:var(--muted);margin-bottom:7px}select{width:100%;margin-bottom:9px}.list{max-height:690px;overflow:auto}.group{font:11px 'Courier New',monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);padding:16px 6px 9px}.room{width:100%;display:flex;text-align:left;gap:9px;padding:7px;margin:2px 0;align-items:center}.room[aria-current=true]{background:#303829;border-color:var(--accent)}.room img{width:62px;height:auto;aspect-ratio:4/3;object-fit:contain;background:#111}.room span{min-width:0;overflow-wrap:anywhere}.room small{display:block;font-size:10px;margin-top:5px}main{min-width:0;padding:25px 28px}.scenehead{display:flex;justify-content:space-between;gap:12px;align-items:start}.aliases{font:11px/1.7 'Courier New',monospace;overflow-wrap:anywhere;max-width:800px}.modes{margin:20px 0 12px;display:flex;gap:6px}.images{display:grid;grid-template-columns:1fr 1fr;gap:12px}.images.single{grid-template-columns:1fr}.images figure{margin:0;min-width:0;background:#0d100e;border:1px solid var(--line)}figcaption{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;color:var(--muted);font:11px 'Courier New',monospace}.imagebox{min-height:180px;display:flex;align-items:center;justify-content:center}.imagebox img{display:block;width:100%;height:auto;cursor:zoom-in}.single .imagebox img{max-height:64vh;width:auto;max-width:100%;object-fit:contain}.placeholder{padding:40px 20px;color:var(--muted);line-height:1.7}.chips{display:flex;gap:6px;flex-wrap:wrap;margin:15px 0 9px}.chip{font:10px 'Courier New',monospace;border:1px solid var(--line);padding:5px 7px;border-radius:20px;color:var(--muted)}details{font-size:12px;line-height:1.7;color:var(--muted);overflow-wrap:anywhere}summary{color:var(--muted)}.decision{border-top:1px solid var(--line);margin-top:20px;padding-top:18px}.decision label{display:block;margin-bottom:8px}.decision textarea{resize:vertical;width:100%;padding:10px;min-height:65px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}#approve{background:var(--accent);color:#1b2415;border-color:var(--accent)}#rework{color:var(--warn)}#decisionStatus{margin-left:auto;align-self:center;color:var(--accent);font-size:12px}footer{padding:18px 28px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}#notice{min-height:22px;color:var(--warn);margin-top:8px}dialog{background:var(--bg);color:var(--ink);border:1px solid var(--line);max-width:96vw;max-height:94vh;padding:12px}dialog::backdrop{background:#000c}.zoomscroll{overflow:auto;max-width:90vw;max-height:80vh;margin-top:10px}.zoomscroll img{display:block;max-width:none}#importFile{display:none}.exclude{max-height:260px;overflow:auto}.exclude p{padding:8px;border-bottom:1px solid var(--line)}[hidden]{display:none!important}@media(max-width:760px){header{padding:17px;align-items:start;flex-direction:column}.layout{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line);padding:12px 17px}.filters{display:flex;gap:9px}.filters label{flex:1;min-width:0}.list{display:flex;gap:6px;overflow:auto;max-height:115px}.group{display:none}.room{flex:0 0 178px;margin:0}.room img{width:47px}main{padding:20px 17px}.scenehead{flex-direction:column}.images{gap:8px}figcaption{font-size:9px;padding:8px 6px;flex-wrap:wrap}.imagebox{min-height:110px}.placeholder{padding:15px 8px;font-size:12px}h2{font-size:23px}.actions button{flex:1;padding:10px 7px;font-size:12px}#decisionStatus{width:100%;margin:4px 0}footer{padding:17px}header .toolbar button{font-size:12px}.modes button{flex:1;padding:9px}.single .imagebox img{max-height:55vh}}
aside,.scenehead>div{min-width:0}h2{overflow-wrap:anywhere}#search{width:100%;padding:9px;margin-bottom:9px}
</style></head><body>
<header><div><div class="eyebrow">NEVERHOOD / PRIVATE ARCHIVE / MANUAL REVIEW</div><h1>Background Review</h1><div id="summary" class="summary"></div></div><div class="toolbar"><button id="export">Export JSON</button><button id="import">Import JSON</button><input id="importFile" type="file" accept=".json,application/json"><a href="report.html" id="technicalTop">Technical report</a></div></header>
<div class="layout"><aside><div class="filters"><label>Search scenes and experiments<input id="search" type="search" placeholder="1201, Hall of Fame, resource ID"></label><label>Decision<select id="filter"><option value="all">All candidates</option><option value="pending">Pending review</option><option value="approved">Approved</option><option value="rework">Needs rework</option><option value="unavailable">Attempts without images</option></select></label><label>Origin<select id="origin"><option value="all">All</option><option value="new">New</option><option value="historical">Historical</option></select></label><label id="categoryLabel" hidden>Category<select id="category"><option value="all">All categories</option></select></label></div><nav id="list" class="list" aria-label="Scenes and experiments"></nav></aside>
<main><div class="scenehead"><div><div class="eyebrow" id="position"></div><h2 id="title"></h2><div id="aliases" class="aliases muted"></div></div><div class="toolbar"><button id="prev" aria-label="Previous candidate">←</button><button id="next" aria-label="Next candidate">→</button></div></div>
<label>A: source / candidate version<select id="compareVersion"></select></label>
<label><input id="migrate" type="checkbox"> Import matching artifact decisions from a previous manifest (explicit migration)</label>
<div class="modes" aria-label="Comparison mode"><button data-mode="pair" aria-pressed="true">A / B</button><button data-mode="a" aria-pressed="false">A only</button><button data-mode="b" aria-pressed="false">B only</button></div>
<div id="images" class="images"><figure id="figureA"><figcaption><span id="captionA"></span><a id="linkA" target="_blank" rel="noopener">Full size</a></figcaption><div class="imagebox"><img id="imageA" alt="A: original source" loading="lazy"><div id="missingSource" class="placeholder" hidden>Source image unavailable.</div></div></figure><figure id="figureB"><figcaption><span id="captionB"></span><a id="linkB" target="_blank" rel="noopener">Full size</a></figcaption><div class="imagebox"><img id="imageB" alt="B: candidate output" loading="lazy"><div id="missing" class="placeholder" hidden>Final image unavailable.<br>This attempt cannot be approved.</div></div></figure></div>
<p id="experimentWarning" class="muted" hidden></p><div id="chips" class="chips"></div><details id="diagnostics"><summary>Technical evidence, not a quality decision</summary><div id="issues"></div><a id="technicalDetail" href="report.html">Open technical report</a></details>
<section class="decision" aria-label="Manual decision"><label for="notes">Review notes</label><textarea id="notes" placeholder="Geometry, details, lighting, symbols..." maxlength="20000"></textarea><div class="actions"><button id="approve">Approve</button><button id="rework">Request rework</button><button id="defer">Defer</button><span id="decisionStatus"></span></div></section>
<p class="muted"><small>Technical flags do not replace visual review. Decisions do not start jobs or modify game files.</small></p><div id="notice" role="status" aria-live="polite"></div>
</main></div><footer><p>Decisions and notes are stored only in this browser's localStorage, scoped to the current manifest and image hashes. Export JSON for a backup. Import replaces local decisions only after validating the manifest and every candidate.</p><div id="relatedReviews" class="toolbar"></div><details><summary>Excluded sources and unresolved coverage</summary><p id="coverage"></p><div id="exclusions" class="exclude"></div><a id="technicalCoverage" href="report.html">Full technical report</a></details></footer>
<dialog id="zoom"><button id="closeZoom">Close</button><span class="muted"> 1:1 · scroll to inspect details</span><div class="zoomscroll"><img id="zoomImage" alt="Image at original size"></div></dialog>
<script id="review-data" type="application/json">__REVIEW_DATA__</script>
<script>
'use strict';
const D=JSON.parse(document.getElementById('review-data').textContent), $=id=>document.getElementById(id);
if(D.technicalReportUrl){for(const id of ['technicalTop','technicalDetail','technicalCoverage']){$(id).href=D.technicalReportUrl;$(id).textContent=D.technicalReportLabel??'Catalog details'}}
const labels={pending:'Pending review',approved:'Manually approved',rework:'Needs rework',unavailable:'No output'};
const categoryLabels={'production':'Production','historical-experiment':'Historical experiment','paired-experiment':'Paired experiment','unavailable':'Unavailable'};
const categoryOf=r=>r.category??'production';
function timestamp(r){const raw=r.startedAt??r.createdAt??r.timestamp;if(!raw)return '';const date=new Date(raw);return Number.isNaN(date.getTime())?String(raw):date.toISOString().replace('T',' ').replace(/\.\d{3}Z$/,' UTC')}
const identity=r=>({id:r.id,candidateId:r.candidateId,sourceSha256:r.source?.sha256??null,outputSha256:r.output?.sha256??null});
const decisionKey=r=>r.artifactId??r.id;
const key='neverhood-manual-review:v2:'+D.manifestSha256+':'+D.rooms.map(r=>r.artifactId??r.id).join('|');
let decisions={},selected=D.rooms[0].id,mode='pair';
function status(r){return !r.available?'unavailable':decisions[decisionKey(r)]?.decision??'pending'}
function notice(text){$('notice').textContent=text}
function envelope(){return {schemaVersion:2,manifestSha256:D.manifestSha256,candidates:D.rooms.map(identity),decisions:D.rooms.map(r=>({...identity(r),decision:decisions[decisionKey(r)]?.decision??'pending',notes:decisions[decisionKey(r)]?.notes??''}))}}
function validate(doc,migrate=false){
 if(migrate)return migrateDecisions(doc);
  if(!doc||doc.schemaVersion!==2||doc.manifestSha256!==D.manifestSha256)throw Error('Manifest mismatch. Import rejected.');
 const expected=D.rooms.map(identity);
  if(!Array.isArray(doc.candidates)||doc.candidates.length!==expected.length||!Array.isArray(doc.decisions)||doc.decisions.length!==expected.length)throw Error('Incomplete candidate coverage.');
 const result=Object.create(null), seen=new Set();
 for(let i=0;i<expected.length;i++){
  const a=doc.candidates[i],e=expected[i];
  if(!a||Object.keys(e).some(k=>a[k]!==e[k]))throw Error('Candidate hashes mismatch. Import rejected.');
 }
 for(const item of doc.decisions){
  const r=D.rooms.find(r=>r.id===item?.id);
  if(!r||seen.has(r.id)||Object.keys(identity(r)).some(k=>item[k]!==identity(r)[k]))throw Error('Stale or duplicate decision.');
  if(!['pending','approved','rework'].includes(item.decision)||typeof item.notes!=='string'||item.notes.length>20000||(!r.canApprove&&item.decision==='approved'))throw Error('Invalid candidate decision.');
   const record={decision:item.decision,notes:item.notes},k=decisionKey(r);
   if(result[k]&&JSON.stringify(result[k])!==JSON.stringify(record))throw Error('Conflicting artifact decisions');
   seen.add(r.id);result[k]=record;
 }
 return result;
}
function migrateDecisions(doc){
 if(!doc||![1,2].includes(doc.schemaVersion)||typeof doc.manifestSha256!=='string'||!Array.isArray(doc.candidates)||!Array.isArray(doc.decisions)||doc.candidates.length!==doc.decisions.length)throw Error('Invalid migration envelope');
 const result={...decisions},seen=new Set();
 for(const item of doc.decisions){
  const declared=doc.candidates.filter(c=>c.id===item.id&&c.candidateId===item.candidateId);
  if(seen.has(item.id)||declared.length!==1||['sourceSha256','outputSha256'].some(k=>declared[0][k]!==item[k]))throw Error('Unvalidated artifact identity');
  seen.add(item.id);
  if(!['pending','approved','rework'].includes(item.decision)||typeof item.notes!=='string'||item.notes.length>20000||item.decision==='approved'&&!item.outputSha256)throw Error('Invalid migration decision');
  if(!item.sourceSha256||!item.outputSha256)continue;
  for(const r of D.rooms.filter(r=>r.source?.sha256===item.sourceSha256&&r.output?.sha256===item.outputSha256)){
   if(item.decision==='approved'&&!r.canApprove)throw Error('Invalid artifact approval');
   const k=decisionKey(r);
   if(result[k]&&(result[k].decision!=='pending'||result[k].notes!=='')&&JSON.stringify(result[k])!==JSON.stringify({decision:item.decision,notes:item.notes}))throw Error('Conflicting artifact decisions');
   result[k]={decision:item.decision,notes:item.notes};
  }
 }
 return result;
}
function save(){try{localStorage.setItem(key,JSON.stringify(envelope()));notice('Saved locally. Export JSON for a backup.')}catch{notice('Browser storage unavailable. Export JSON before closing this page.')}}
 try{const saved=localStorage.getItem(key);if(saved)decisions=validate(JSON.parse(saved));else if(D.previousCatalogManifestSha256){const prefix='neverhood-manual-review:v2:'+D.previousCatalogManifestSha256+':';for(let i=0;i<localStorage.length;i++){const oldKey=localStorage.key(i);if(!oldKey?.startsWith(prefix))continue;const old=JSON.parse(localStorage.getItem(oldKey));if(old.manifestSha256!==D.previousCatalogManifestSha256)continue;decisions=migrateDecisions(old);localStorage.setItem(key,JSON.stringify(envelope()));notice('Previous local decisions restored for identical image hashes. New versions remain pending.');break}}}catch{notice('Local data unavailable or stale; decisions were not restored.')}
let restoredApprovals=false;for(const item of D.savedDecisions??[]){const r=D.rooms.find(r=>r.id===item.id&&r.source?.sha256===item.sourceSha256&&r.output?.sha256===item.outputSha256);if(r?.canApprove&&item.decision==='approved'&&(!decisions[decisionKey(r)]||decisions[decisionKey(r)].decision==='pending')){decisions[decisionKey(r)]={decision:'approved',notes:decisions[decisionKey(r)]?.notes??item.notes??''};restoredApprovals=true}}if(restoredApprovals)save();
 const hasCategories=D.rooms.some(r=>r.category);
for(const category of new Set(D.rooms.map(categoryOf))){const option=document.createElement('option');option.value=category;option.textContent=categoryLabels[category]??category;$('category').append(option)}
$('categoryLabel').hidden=!hasCategories;
function visible(){const query=$('search').value.trim().toLocaleLowerCase();return D.rooms.filter(r=>($('filter').value==='all'||status(r)===$('filter').value)&&($('origin').value==='all'||r.origin===$('origin').value)&&($('category').value==='all'||categoryOf(r)===$('category').value)&&(!query||[r.roomId,r.label,r.resourceId,r.candidateId,categoryLabels[categoryOf(r)],...(r.aliases??[])].join(' ').toLocaleLowerCase().includes(query)))}
function list(){
 const rooms=visible();$('list').replaceChildren();
 const versions=new Set(D.rooms.map(r=>r.roomId)).size<D.rooms.length;
  for(const origin of hasCategories?[...new Set(rooms.map(categoryOf))]:versions?[...new Set(rooms.map(r=>r.roomId))]:['new','historical']){
    const group=rooms.filter(r=>(hasCategories?categoryOf(r):versions?r.roomId:r.origin)===origin);if(!group.length)continue;
    const heading=document.createElement('div');heading.className='group';heading.textContent=(hasCategories?categoryLabels[origin]??origin:versions?origin:origin==='new'?'New':'Historical')+' / '+group.length;$('list').append(heading);
  for(const r of group){const b=document.createElement('button');b.className='room';b.dataset.room=r.id;b.setAttribute('aria-current',String(r.id===selected));
    const img=document.createElement('img');img.loading='lazy';if(r.source)img.src=r.source.url;img.alt='';
    const text=document.createElement('span');text.textContent=r.label;const sub=document.createElement('small');sub.textContent=[labels[status(r)],timestamp(r)].filter(Boolean).join(' · ');text.append(sub);b.append(img,text);b.onclick=()=>{selected=r.id;draw()};$('list').append(b);
  }
 }
  if(!rooms.length){const p=document.createElement('p');p.textContent='No candidates match these filters.';$('list').append(p)}
  const sceneCount=new Set(D.rooms.map(r=>r.roomId)).size,availableScenes=new Set(D.rooms.filter(r=>r.available).map(r=>r.roomId)).size;
   const coverage=D.coverageSummary;
   $('summary').textContent=(coverage?coverage.originalBackgrounds+' original backgrounds · '+coverage.savedFinalImages+' saved image versions · '+coverage.pairedExperimentImages+' unmapped experiment':availableScenes+' / '+sceneCount+' scenes or experiments with output · '+D.rooms.filter(r=>r.available).length+' versions')+' · '+D.rooms.filter(r=>status(r)==='approved').length+' approved · '+D.rooms.filter(r=>status(r)==='rework').length+' need rework';
}
function modes(){for(const b of document.querySelectorAll('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===mode));$('figureA').hidden=mode==='b';$('figureB').hidden=mode==='a';$('images').classList.toggle('single',mode!=='pair')}
function draw(){
 list();const r=D.rooms.find(r=>r.id===selected);$('title').textContent=r.label+' / '+r.resourceId;
  $('position').textContent=[String(D.rooms.indexOf(r)+1).padStart(2,'0')+' / '+D.rooms.length,r.origin==='new'?'NEW':'HISTORICAL',timestamp(r)].filter(Boolean).join(' · ');$('aliases').textContent=(r.aliases??[]).join(' | ');
   const comparison=$('compareVersion'),previous=comparison.dataset.room===r.id?comparison.value:'source';comparison.dataset.room=r.id;comparison.replaceChildren();
   const sources=[{label:'Original source',meta:r.source},...(r.additionalSources??[])];
   for(const [value,label] of [...sources.map((s,i)=>[i?'source:'+i:'source',s.label]),...D.rooms.filter(v=>v.roomId===r.roomId&&v.available&&v.id!==r.id).map(v=>[v.id,v.label+' / '+v.candidateId+(timestamp(v)?' / '+timestamp(v):'')])]){const o=document.createElement('option');o.value=value;o.textContent=label;comparison.append(o)}
  comparison.value=[...comparison.options].some(o=>o.value===previous)?previous:'source';
   const sourceIndex=comparison.value==='source'?0:comparison.value.startsWith('source:')?Number(comparison.value.slice(7)):-1;
   const reference=sourceIndex>=0?sources[sourceIndex]?.meta:D.rooms.find(v=>v.id===comparison.value)?.output;
  for(const [suffix,meta] of [['A',reference],['B',r.output]]){
  const img=$('image'+suffix),link=$('link'+suffix);img.hidden=!meta;link.hidden=!meta;
   const placeholder=$(suffix==='A'?'missingSource':'missing');
   const failed=()=>{img.hidden=true;link.hidden=true;placeholder.hidden=false;placeholder.textContent=suffix==='A'?'Source image could not be loaded. Metadata is not proof of a readable image.':'Candidate image could not be loaded. Review the technical evidence.'};
   img.onerror=failed;img.onload=()=>{img.hidden=false;link.hidden=false;placeholder.hidden=true};placeholder.hidden=Boolean(meta);
   if(meta){if(img.getAttribute('src')!==meta.url)img.src=meta.url;else if(img.complete&&!img.naturalWidth)failed();link.href=meta.url;const label=suffix==='A'?comparison.selectedOptions[0].textContent:r.label+' / '+r.candidateId;img.alt=suffix+': '+label;$('caption'+suffix).textContent=suffix+' · '+label+' · '+(meta.dimensions??[]).join(' × ')}else{img.removeAttribute('src');link.removeAttribute('href');placeholder.textContent=suffix==='A'?'Source image unavailable.':'Final image unavailable. This attempt cannot be approved.';$('caption'+suffix).textContent=suffix+' · '+(suffix==='A'?'Source unavailable':'No output')}
 }
  $('approve').disabled=!r.canApprove;$('rework').disabled=!r.available;
  const experimental=(r.category??'').includes('experiment');$('experimentWarning').hidden=!experimental&&!r.warning;
  $('experimentWarning').textContent=r.warning??(r.canApprove?'Experimental output. Review manually; no approval is automatic.':'Experimental output, not mapped to a production room. It cannot be approved as a room; notes and rework remain available.');
  $('notes').value=decisions[decisionKey(r)]?.notes??'';$('decisionStatus').textContent=labels[status(r)];
  for(const [id,value] of [['approve','approved'],['rework','rework'],['defer','pending']])$(id).setAttribute('aria-pressed',String((decisions[decisionKey(r)]?.decision??'pending')===value));
   const colorWarning=(r.issues??[]).some(i=>i.kind==='localized-color-warning');
   $('chips').replaceChildren();for(const text of [r.available?'Image saved':'Archived attempt: no image',r.provenanceStatus==='complete'?'Request provenance complete':'Request provenance has caveats',colorWarning?'Color: localized warning, not a rejection':'Quality: manual decision required']){const chip=document.createElement('span');chip.className='chip';chip.textContent=text;$('chips').append(chip)}
  $('issues').replaceChildren();for(const text of [r.candidateId,'Observed status: '+(r.observedStatus??'unknown'),'Structure has not been verified automatically.',...(r.issues??[]).map(i=>i.kind+': '+i.reason)]){const p=document.createElement('p');p.textContent=text;$('issues').append(p)}
 $('diagnostics').open=false;modes();
}
function decide(value){const r=D.rooms.find(r=>r.id===selected);if(value==='approved'&&!r.canApprove)return;decisions[decisionKey(r)]={decision:value,notes:$('notes').value};save();draw()}
$('approve').onclick=()=>decide('approved');$('rework').onclick=()=>decide('rework');$('defer').onclick=()=>decide('pending');
 $('notes').oninput=()=>{const k=decisionKey(D.rooms.find(r=>r.id===selected));decisions[k]={decision:decisions[k]?.decision??'pending',notes:$('notes').value};save()};
for(const id of ['filter','origin','category'])$(id).onchange=()=>{const rooms=visible();if(rooms.length&&!rooms.some(r=>r.id===selected))selected=rooms[0].id;draw()};
$('search').oninput=()=>{const rooms=visible();if(rooms.length&&!rooms.some(r=>r.id===selected))selected=rooms[0].id;draw()};
for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{mode=b.dataset.mode;modes()};
function step(delta){const rooms=visible();if(!rooms.length)return;selected=rooms[(Math.max(0,rooms.findIndex(r=>r.id===selected))+delta+rooms.length)%rooms.length].id;draw()}
$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);
for(const suffix of ['A','B'])$('image'+suffix).onclick=()=>{$('zoomImage').src=$('image'+suffix).src;$('zoom').showModal()};
$('closeZoom').onclick=()=>$('zoom').close();$('zoom').onclose=()=>$('zoomImage').removeAttribute('src');
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(envelope(),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='neverhood-manual-review-'+D.manifestSha256.slice(0,12)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notice('JSON exported. Keep the backup in a private location.')};
 $('import').onclick=()=>$('importFile').click();$('importFile').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>3000000)throw Error('File too large.');const next=validate(JSON.parse(await file.text()),$('migrate').checked);decisions=next;save();draw();notice('Import validated and saved locally.')}catch(error){notice(error.message)}finally{event.target.value=''}};
 $('compareVersion').onchange=()=>draw();
$('coverage').textContent=D.coverageNote;
for(const d of D.exclusions){const p=document.createElement('p');p.textContent=[d.scene,d.resourceId,d.id,d.disposition,d.reason].filter(Boolean).join(' · ');$('exclusions').append(p)}
if(!D.exclusions.length)$('exclusions').textContent='No additional exclusions in this report.';
for(const item of D.relatedReviews??[]){const a=document.createElement('a');a.href=item.url;a.textContent=item.title;$('relatedReviews').append(a)}
draw();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('--overwrite', action='store_true', help='Explicitly replace existing review snapshot')
    args = parser.parse_args()
    data = build_data(args.run)
    if not args.overwrite and any((args.run / name).exists() for name in ('review.html', 'manual-review-data.json')):
        parser.error('Review snapshot exists; use a new repair run or explicit --overwrite')
    for name, content in [('manual-review-data.json', json.dumps(data, ensure_ascii=False, indent=2)),
                          ('review.html', render(data))]:
        path = args.run / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if args.overwrite else os.O_EXCL), 0o600)
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(content)
        print(path.resolve())


if __name__ == '__main__':
    main()
