"""Synthetic integration fixture. All confirmations are automated test actions.

No real account or customer acceptance is represented by this fixture.
"""
import hashlib
import json
import sys
import uuid
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT/'scripts'), str(ROOT/'skills/content-runtime/scripts')]
from native_demo import offline_layout
from native_demo_data import package_body, blueprint_body
from content_runtime import ContentRuntime
import author_evidence
from visual_publish import generate_publish_outputs
from delivery_pack import publication_delivery_prerequisites, build_delivery_pack
from delivery_audit import run_delivery_audit, inspect_delivery_package_integrity


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')


def prepare(project, platforms):
    rt = ContentRuntime(project); rt.init()
    run = rt.create_run(topic='虚构协作练习', platforms=platforms, slug='delivery-test', run_id='delivery-test', source='automated-contract-test')
    slug = run['slug']
    raw = '虚构练习：文章之外新增演示材料。请先核对交付范围，不含客户成果。'
    rt.write('intake', slug, '# 素材\n\n'+raw, run_id=slug)
    fingerprint = author_evidence.digest({'rawMaterial': raw, 'files': [], 'links': []})
    write(project/f'sessions/material-analysis/{slug}.json', {
        'schema':'aifios.material-analysis.v1', 'runId':slug, 'inputFingerprint':fingerprint,
        'analysisInputFingerprint':fingerprint,'analysisStatus':'current',
        'input':{'rawMaterial':raw,'files':[],'links':[]},
        'analysis':{'summary':raw,'opinions':['先核对范围'],'facts':[],'cases':[],'authorRequirements':['不编造效果'],'risks':[]},
        'selection':{'materialTypeId':'method','structureId':'problem-method'}})
    context=rt.author_source_context(slug)
    binding=rt.select_author_source({'run_id':slug,'id':'author_'+uuid.uuid4().hex,'topic':run['topic'],**{k:context[k] for k in ('intake_path','intake_sha256','material_sha256','source_revision')}})
    plan=rt.write('blueprint',slug,blueprint_body(platforms)+'\n'+author_evidence.binding_lines(binding),run_id=slug)
    rt.approve_artifact('topic_template',plan['path'],slug)
    package=rt.write('package',slug,package_body(platforms),run_id=slug)
    rt.approve_artifact('content_package',package['path'],slug,reviewed_plan_sha256=hashlib.sha256(Path(plan['path']).read_bytes()).hexdigest())
    visual_path=None
    if set(platforms)&{'wechat','xhs'}:
        with offline_layout():
            result=generate_publish_outputs(project,slug,package['path'])
        index=json.loads(Path(result['index_path']).read_text())
        assert index['quality_summary']['status']=='pass',index['quality_summary']
        selections={o['id']:{'assetId':o['id'],'semanticRole':o['id'],'revisionId':index['revision_id'],'path':o['output'],'sha256':o['sha256'], 'platformBindings':['wechat' if o['id']=='wechat-html' else 'xiaohongshu']} for o in index['outputs']}
        visual_path=f'pipeline/visual/{slug}/selected-assets.json'
        write(project/visual_path,{'schema':'aifios.visual-asset-manifest.v1','slug':slug,'sourceContentHash':hashlib.sha256(Path(package['path']).read_bytes()).hexdigest(),'requiredRoles':list(selections),'selections':selections})
        rt.register_phase_artifact('visual_assets',visual_path,slug)
        rt.approve_artifact('visual_assets',visual_path,slug)
    return {'runId':slug,'packagePath':str(Path(package['path']).relative_to(project)), 'visualPath':visual_path}


def finish(project):
    rt=ContentRuntime(project); slug='delivery-test'; queue=f'materials/publication/drafts/{slug}/draft-queue.json'
    rt.register_phase_artifact('draft_information',queue,slug); rt.approve_artifact('draft_information',queue,slug)
    run=rt.run_state(run_id=slug)
    pre=publication_delivery_prerequisites(project,run)
    if pre['errors']: return {'prerequisites':pre}
    audit=run_delivery_audit(project,run_id=slug,auto_pack=True)
    return {'prerequisites':pre,'audit':audit}

if __name__=='__main__':
    project=Path(sys.argv[2]).resolve()
    if sys.argv[1]=='prepare': result=prepare(project,json.loads(sys.argv[3]))
    elif sys.argv[1]=='finish': result=finish(project)
    elif sys.argv[1]=='check': result=publication_delivery_prerequisites(project,ContentRuntime(project).run_state(run_id='delivery-test'))
    elif sys.argv[1]=='audit': result=run_delivery_audit(project,run_id='delivery-test',auto_pack=True)
    elif sys.argv[1]=='pack':
        try: result=build_delivery_pack(project,run_id='delivery-test')
        except RuntimeError as exc: result={'status':'blocked','zip_path':None,'reason':str(exc)}
    elif sys.argv[1]=='inspect':
        directory=Path(sys.argv[3]); manifest=json.loads((directory/'manifest.json').read_text())
        result=inspect_delivery_package_integrity(manifest,directory,str(directory)+'.zip')
    else: raise ValueError('unsupported test command')
    print(json.dumps(result,ensure_ascii=False))
