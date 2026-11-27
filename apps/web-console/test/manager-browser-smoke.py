"""真实项目数据与对话存储的离线模型浏览器验收，不产生 Provider 费用。"""
import argparse
import json
import uuid
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--base-url', default='http://127.0.0.1:5177')
parser.add_argument('--screenshots', default='/tmp')
args = parser.parse_args()
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    response = page.request.post(args.base_url + '/api/projects', data={'name': '退款体验 · 项目经理对话', 'goal': '让客户清楚了解退款进度', 'idempotencyKey': str(uuid.uuid4())}, headers={'Origin': args.base_url})
    assert response.ok, response.status
    project_id = response.json()['id']
    page.goto(args.base_url + '/#/projects/' + project_id, wait_until='networkidle')
    page.get_by_role('button', name='询问项目经理').click()
    panel = page.get_by_role('region', name='项目经理对话')
    expect(panel.get_by_text('先把最重要的问题说清楚。')).to_be_visible()
    page.get_by_label('向项目经理提问').fill('当前应该优先关注什么？')
    panel.get_by_role('button', name='发送问题').click()
    expect(panel.locator('.is-assistant')).to_contain_text('离线验收回复', timeout=15000)
    expect(panel.locator('.is-assistant')).to_contain_text('退款范围和成功标准')
    panel.get_by_role('button', name='收起对话').click()
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='询问项目经理').click()
    expect(panel.locator('.is-assistant')).to_contain_text('离线验收回复')
    page.get_by_label('向项目经理提问').fill('我想补充新的工作目标。')
    panel.get_by_role('button', name='发送问题').click()
    panel.get_by_role('button', name='停止回复').click()
    expect(panel.get_by_text('本轮回复已停止。')).to_be_visible(timeout=15000)
    for width in (375, 768, 1024, 1440):
        page.set_viewport_size({'width': width, 'height': 1100})
        assert page.locator('body').evaluate('node => node.scrollWidth <= innerWidth'), width
        panel.scroll_into_view_if_needed()
        panel.screenshot(path=str(Path(args.screenshots) / f'manager-conversation-{width}.png'), animations='disabled')
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'projectId': project_id, 'widths': [375, 768, 1024, 1440], 'paidModelCalls': 0, 'pageErrors': errors}, ensure_ascii=False))
    browser.close()
