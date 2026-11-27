"""使用真实本机控制面验收正式产品，不调用付费模型。"""
import argparse
import json
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--base-url", default="http://127.0.0.1:5175")
parser.add_argument("--screenshots", default="/tmp")
args = parser.parse_args()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{args.base_url}/#/projects", wait_until="networkidle")
    page.get_by_role("button", name="创建项目", exact=True).click()
    page.get_by_label("项目名称", exact=True).fill("客户退款体验升级 · 正式界面验收")
    page.get_by_label("希望达成的结果").fill("让客户随时了解退款进度，减少等待与重复咨询。")
    page.get_by_role("dialog").get_by_role("button", name="创建项目", exact=True).click()
    expect(page.get_by_role("heading", name="客户退款体验升级", exact=False)).to_be_visible()
    project_id = page.url.split("/projects/")[-1]
    page.get_by_role("button", name="添加工作目标").click()
    page.get_by_label("工作目标名称").fill("明确退款进度方案与成功标准")
    page.get_by_label("希望达成的结果").fill("提供清晰的退款进度和处理结果，让客户无需反复咨询。")
    page.get_by_label("成功标准").fill("客户可查看退款进度\n客服可解释异常原因\n处理结果可以追溯")
    page.get_by_role("button", name="建立工作目标").click()
    expect(page.get_by_role("heading", name="明确退款进度方案与成功标准", exact=True)).to_be_visible()
    task_id = page.url.split("/tasks/")[-1]
    content = "# 退款进度：问题确认\n\n## 希望解决的问题\n客户无法了解退款进度，会反复向客服询问。\n\n## 交付目标\n提供申请、审核、到账三个清晰阶段，并保留异常解释。\n\n## 成功标准\n- 客户能查看当前阶段。\n- 超时或失败时展示原因和处理建议。\n- 客服可以追溯每次更新。\n\n## 本次决定\n请确认上述范围，批准后进入研究与方案阶段。"
    response = page.request.post(f"{args.base_url}/api/tasks/{task_id}/artifacts", data={"type": "questions", "content": content, "sourceArtifacts": []}, headers={"Idempotency-Key": str(uuid.uuid4()), "Origin": args.base_url})
    assert response.ok, (response.status, response.text())
    artifact = response.json()
    page.goto(f"{args.base_url}/#/", wait_until="networkidle")
    page.reload(wait_until="networkidle")
    page.get_by_label("关注项目").select_option(project_id)
    card = page.locator(f'[data-decision-id="review_artifact:{artifact["artifactId"]}"]')
    expect(card).to_be_visible()
    for width in (375, 768, 1024, 1440):
        page.set_viewport_size({"width": width, "height": 1100})
        assert page.locator("body").evaluate("node => node.scrollWidth <= window.innerWidth"), width
        page.screenshot(path=str(Path(args.screenshots) / f"formal-inbox-{width}.png"), full_page=True, animations="disabled")
    page.set_viewport_size({"width": 1440, "height": 1100})
    card.get_by_role("button", name="处理此事项").click()
    expect(page.get_by_role("region", name="交付物正文")).to_contain_text("客户无法了解退款进度")
    expect(page.get_by_role("button", name="批准问题确认", exact=True)).to_be_enabled()
    page.screenshot(path=str(Path(args.screenshots) / "formal-decision.png"), full_page=True, animations="disabled")
    page.get_by_role("button", name="批准问题确认", exact=True).click()
    expect(page).to_have_url(f"{args.base_url}/#/")
    page.get_by_label("关注项目").select_option(project_id)
    advance = page.locator(".product-decision-card").filter(has_text="推进明确退款进度方案与成功标准")
    expect(advance).to_be_visible()
    advance.get_by_role("button", name="处理此事项").click()
    page.get_by_role("button", name="推进至研究分析", exact=True).click()
    expect(page).to_have_url(f"{args.base_url}/#/")
    page.goto(f"{args.base_url}/#/projects/{project_id}", wait_until="networkidle")
    expect(page.get_by_role("button", name="明确退款进度方案与成功标准", exact=True)).to_be_visible()
    expect(page.locator(".product-story-stage")).to_contain_text("研究分析")
    page.get_by_role("button", name="询问项目经理").click()
    expect(page.get_by_role("region", name="项目经理对话")).to_contain_text("带着当前项目目标和工作阶段")
    page.screenshot(path=str(Path(args.screenshots) / "formal-project.png"), full_page=True, animations="disabled")
    page.goto(f"{args.base_url}/#/deliveries", wait_until="networkidle")
    delivery = page.locator(f'[data-artifact-id="{artifact["artifactId"]}"]')
    delivery.locator("summary").click()
    expect(delivery.get_by_role("region", name="交付物正文")).to_contain_text("客户无法了解退款进度")
    page.goto(f"{args.base_url}/#/", wait_until="networkidle")
    assert page.locator(".local-tag").count() == 0
    page.emulate_media(reduced_motion="reduce")
    page.set_viewport_size({"width": 375, "height": 812})
    page.get_by_role("button", name="打开产品导航").click()
    page.keyboard.press("Escape")
    expect(page.locator(".product-sidebar")).not_to_have_class("product-sidebar open")
    assert not errors, errors
    print(json.dumps({"result": "passed", "widths": [375, 768, 1024, 1440], "projectId": project_id, "taskId": task_id, "artifactId": artifact["artifactId"], "pageErrors": errors}, ensure_ascii=False))
    browser.close()
