from playwright.sync_api import sync_playwright


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    errors = []
    for width in (375, 1440):
        page = browser.new_page(viewport={"width": width, "height": 1000})
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        page.goto("http://127.0.0.1:5174/#/", wait_until="networkidle")
        assert page.get_by_role("heading", name="今天要决定的事").count() == 1
        assert page.locator("text=LOCAL").count() == 0
        assert page.locator("text=EXECUTION ENGINE").count() == 0
        assert page.locator("body").evaluate("node => node.scrollWidth <= window.innerWidth")
        page.screenshot(path=f"/tmp/titan-formal-ui-{width}.png", full_page=True)
        page.close()
    assert not errors, errors
    browser.close()
