#!/usr/bin/env python3
"""Capture the deterministic UI walkthrough used in README.

The rendered Next.js application is real. Tenant API responses use the same labelled
browser fixture as the accessibility gate; this asset is presentation evidence only,
not a substitute for the PostgreSQL/Worker/live-model release gates.
"""

from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

from commerce_browser_e2e import MockCommerceBackend, composer, wait_answer, wait_ready


ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:3000/commerce")
    parser.add_argument("--output", default=str(ROOT / "docs" / "assets"))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    frame_durations = [1800, 1200, 4800, 4200, 4200]

    with tempfile.TemporaryDirectory(prefix="commerce-demo-", dir=output) as temporary:
        frame_root = Path(temporary)
        frame_paths: list[Path] = []
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1440, "height": 900},
                device_scale_factor=1,
                locale="zh-CN",
                timezone_id="America/Sao_Paulo",
                reduced_motion="reduce",
            )
            page = context.new_page()
            backend = MockCommerceBackend()
            console_errors: list[str] = []
            page.on(
                "console",
                lambda message: console_errors.append(message.text)
                if message.type == "error" else None,
            )
            page.route("**/api/commerce**", backend.handle)
            page.goto(args.origin, wait_until="networkidle", timeout=60_000)
            wait_ready(page)
            page.get_by_text("公开演示数据披露", exact=False).wait_for(state="visible")

            def capture(name: str) -> None:
                path = frame_root / f"{len(frame_paths):02d}-{name}.png"
                page.screenshot(path=str(path), full_page=False, timeout=10_000)
                frame_paths.append(path)

            capture("ready")
            question = "诊断上一完整周经营表现；先检查数据健康与基准，再定位增长来源和拖累项"
            composer(page).fill(question)
            capture("question")
            page.get_by_label("发送问题").click()
            wait_answer(page, "上一完整周 GMV")
            page.wait_for_timeout(300)
            capture("diagnosis")

            evidence_toggle = page.locator("aside").get_by_role("button", name="核对实际结果").first
            if evidence_toggle.get_attribute("aria-expanded") != "true":
                evidence_toggle.click()
            page.wait_for_timeout(200)
            capture("evidence")

            page.get_by_label("对话内容").evaluate(
                "element => { element.scrollTop = Math.min(element.scrollHeight, 760); }"
            )
            page.wait_for_timeout(250)
            capture("findings-action")
            if console_errors:
                raise RuntimeError(f"Console errors while capturing README demo: {console_errors}")
            context.close()
            browser.close()

        frames: list[Image.Image] = []
        for path in frame_paths:
            with Image.open(path) as source:
                resized = source.convert("RGB").resize((1200, 750), Image.Resampling.LANCZOS)
                frames.append(resized.quantize(colors=128, method=Image.Quantize.MEDIANCUT))
        cover = frames[2].convert("RGB")
        cover.save(output / "commerce-agent-demo.png", optimize=True)
        frames[0].save(
            output / "commerce-agent-demo.gif",
            save_all=True,
            append_images=frames[1:],
            duration=frame_durations,
            loop=0,
            optimize=True,
            disposal=2,
        )

    print(f"[commerce-demo] cover={output / 'commerce-agent-demo.png'}")
    print(f"[commerce-demo] animation={output / 'commerce-agent-demo.gif'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
