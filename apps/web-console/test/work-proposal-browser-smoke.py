"""离线模型 + 真实控制面/PostgreSQL：从目标描述到工作提案、人工确认与审批。"""
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
    base = args.base_url
    response = page.request.post(base + '/api/projects', data={'name': '目标到审批 · 工作提案验收', 'goal': '让客户随时了解退款进度', 'idempotencyKey': str(uuid.uuid4())}, headers={'Origin': base})
    assert response.ok, response.status
    project_id = response.json()['id']
    def state():
        response = page.request.get(base + '/api/console/state')
        assert response.ok
        return response.json()
    def tasks():
        return [task for task in state()['tasks'] if task['projectId'] == project_id]
    def open_chat():
        page.goto(base + '/#/projects/' + project_id, wait_until='networkidle')
        page.get_by_role('button', name='询问项目经理').click()
        return page.get_by_role('region', name='项目经理对话')
    panel = open_chat()
    page.get_by_label('本次意图').select_option('work-proposal')
    page.get_by_label('向项目经理提问').fill('请为退款进度建立可验收工作目标，整理问题确认草稿。未知事项标为待确认。')
    panel.get_by_role('button', name='生成工作提案', exact=True).click()
    card = panel.get_by_role('region', name='工作提案')
    expect(card).to_contain_text('离线验收提案', timeout=15000)
    expect(card).to_contain_text('状态延迟、通知频率和客服权限仍待确认')
    assert tasks() == [], '生成不等于确认，不应提前创建任务'
    assert card.locator('img').count() == 0
    for width in (375, 768, 1024, 1440):
        page.set_viewport_size({'width': width, 'height': 1100})
        assert page.locator('body').evaluate('node => node.scrollWidth <= innerWidth'), width
        panel.scroll_into_view_if_needed()
        panel.screenshot(path=str(Path(args.screenshots) / f'work-proposal-{width}.png'), animations='disabled')
    page.set_viewport_size({'width': 1440, 'height': 1100})
    accept_path = f'/local-api/projects/{project_id}/conversation/accept'
    # 丢弃一次已由真实后端成功处理的响应，验证原来源重试仍仅创建一个任务。
    def lose_response(route):
        response = route.fetch()
        assert response.status == 201, response.status
        route.fulfill(status=503, content_type='application/json', body=json.dumps({'code': 'CONTROL_PLANE_UNAVAILABLE'}))
    page.route('**' + accept_path, lose_response, times=1)
    card.get_by_role('button', name='确认建立目标与草稿').click()
    expect(card.get_by_role('alert')).to_contain_text('同一提案重试确认')
    assert len(tasks()) == 1
    card.get_by_role('button', name='确认建立目标与草稿').click()
    expect(card).to_contain_text('草稿仍待审批')
    assert len(tasks()) == 1
    task_id = tasks()[0]['id']
    artifact_response = page.request.get(base + '/api/tasks/' + task_id + '/artifacts')
    artifacts = artifact_response.json()
    assert len(artifacts) == 1
    artifact_id = artifacts[0]['artifactId']
    assert artifacts[0]['reviewState'] == 'pending'
    assert artifacts[0]['status'] == 'draft'
    assert tasks()[0]['stage'] == 'questions'
    assert not [s for s in state()['sessions'] if s['taskId'] == task_id]
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='询问项目经理').click()
    expect(card).to_contain_text('离线验收草稿')
    card.get_by_role('button', name='确认建立目标与草稿').click()
    expect(card).to_contain_text('草稿仍待审批')
    assert len(tasks()) == 1
    assert tasks()[0]['id'] == task_id
    card.get_by_role('button', name='进入草稿审批').click()
    expect(page.get_by_role('heading', name='审阅问题确认。')).to_be_visible()
    expect(page.get_by_role('region', name='交付物正文')).to_contain_text('退款提供方的状态延迟')
    page.get_by_role('button', name='批准问题确认', exact=True).click()
    expect(page).to_have_url(base + '/#/')
    page.get_by_label('关注项目').select_option(project_id)
    decision = page.locator('.product-decision-card').filter(has=page.get_by_role('heading', name='推进退款进度与异常说明 · 离线验收提案', exact=True)).filter(has_text='目标到审批 · 工作提案验收')
    expect(decision).to_be_visible()
    decision.get_by_role('button', name='处理此事项').click()
    page.get_by_role('button', name='推进至研究分析', exact=True).click()
    expect(page).to_have_url(base + '/#/')
    assert tasks()[0]['stage'] == 'research'
    panel = open_chat()
    page.get_by_label('本次意图').select_option('work-proposal')
    page.get_by_label('向项目经理提问').fill('离线验收：非法提案')
    panel.get_by_role('button', name='生成工作提案', exact=True).click()
    expect(panel.get_by_text('提案未通过结构或安全校验', exact=False)).to_be_visible(timeout=15000)
    assert card.count() == 1, '非法提案不应产生新的可确认卡'
    page.get_by_label('向项目经理提问').fill('离线验收：取消提案')
    panel.get_by_role('button', name='生成工作提案', exact=True).click()
    panel.get_by_role('button', name='停止回复').click()
    expect(panel.get_by_text('本轮回复已停止。')).to_be_visible(timeout=15000)
    assert card.count() == 1
    assert len(tasks()) == 1
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'projectId': project_id, 'taskId': task_id, 'artifactId': artifact_id, 'widths': [375,768,1024,1440], 'paidModelCalls': 0, 'pageErrors': errors}, ensure_ascii=False))
    browser.close()
