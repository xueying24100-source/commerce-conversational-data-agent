#!/usr/bin/env python3
"""Deterministic Commerce Agent browser and accessibility release gate.

The Next.js UI is real; only tenant APIs are replaced with a stateful fixture so the
eight release-critical interactions can run without model keys, Feishu credentials,
or a mutable database. Backend integration and real-provider evidence remain separate
release gates and must not be inferred from this report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ORIGIN = "http://127.0.0.1:3000/commerce"
VIEWPORTS = {
    "desktop": {"width": 1440, "height": 900},
    "mobile": {"width": 390, "height": 844},
}
CORE_METRICS = [
    "gmv",
    "paid_orders",
    "visits",
    "conversion_rate",
    "average_order_value",
]
NOW = "2026-08-16T00:00:00.000Z"


def sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def claim(evidence_id: str, path: str, metric: str, value: float, unit: str) -> dict[str, Any]:
    return {
        "evidenceId": evidence_id,
        "path": path,
        "metric": metric,
        "value": value,
        "unit": unit,
    }


def trace(
    evidence_id: str,
    operation: str,
    preview: Any,
    *,
    request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    encoded = json.dumps(preview, ensure_ascii=False, sort_keys=True)
    return {
        "evidenceId": evidence_id,
        "operation": operation,
        "fetchedAt": NOW,
        "rowCount": len(preview) if isinstance(preview, list) else 1,
        "requestSha256": sha(json.dumps(request or {}, sort_keys=True)),
        "responseSha256": sha(encoded),
        "sourceWatermark": "2018-09-03T02:00:00.000Z",
        "request": request or {},
        "preview": preview,
    }


def diagnostic_payload(*, blocked: bool = False) -> dict[str, Any]:
    return {
        "objective": "diagnose_previous_complete_week",
        "dataHealth": {
            "status": "blocked" if blocked else "ready",
            "dataMode": "snapshot",
            "sourceWatermark": "2018-09-03T02:00:00.000Z",
            "reasons": ["visits 指标缺失，无法验证转化率"] if blocked else [],
        },
        "referenceDate": "2018-05-20",
        "timezone": "America/Sao_Paulo",
        "baseline": {
            "strategy": "previous_four_complete_weeks_median",
            "rationale": "使用此前四个完整周中位数抵抗单周尖峰。",
            "comparisonRanges": [
                {"start": "2018-04-09", "end": "2018-04-15"},
                {"start": "2018-04-16", "end": "2018-04-22"},
                {"start": "2018-04-23", "end": "2018-04-29"},
                {"start": "2018-04-30", "end": "2018-05-06"},
            ],
            "confidence": "low" if blocked else "high",
        },
        "stopReason": "data_health_failed" if blocked else "evidence_sufficient",
        "unknowns": ["缺少 visits"] if blocked else [],
        "decisions": [
            {
                "sequence": 1,
                "hypothesis": None if blocked else "growth_driver",
                "chosenNextView": None if blocked else "breakdown",
                "decisionCode": "HEALTH_GATE_BLOCKED" if blocked else "GMV_ORDER_DECOMPOSITION",
                "stopReason": "data_health_failed" if blocked else None,
                "triggerEvidenceIds": ["ev_health" if blocked else "ev_weekly"],
            }
        ],
    }


def answer_fixture(kind: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if kind == "trend":
        trend_rows = [
            {"date": "2018-08-27", "gmv": 132000},
            {"date": "2018-08-28", "gmv": 128000},
            {"date": "2018-08-29", "gmv": 119000},
            {"date": "2018-08-30", "gmv": 111000},
            {"date": "2018-08-31", "gmv": 104000},
        ]
        traces = [trace("ev_trend", "commerce.trend_metric", trend_rows, request={"metric": "gmv"})]
        main_claim = claim("ev_trend", "/4/gmv", "gmv", 104000, "currency")
        return ({
            "status": "answered",
            "answer": "GMV 连续 5 天走低，峰值 132000，谷值 104000，下降具有持续性。",
            "answerClaims": [main_claim],
            "findings": [{
                "metric": "gmv",
                "title": "持续下行趋势",
                "detail": "五个完整日连续下降，并非单日尖峰。",
                "claims": [main_claim],
                "insightLevel": "observed",
                "confidence": 0.99,
                "alternatives": ["渠道结构变化"],
                "contradictionStatus": "clear",
            }],
            "recommendations": [],
            "followUps": [],
        }, traces)

    if kind == "blocked":
        health = {"status": "blocked", "missingMetrics": ["visits"], "factRowCount": 7421}
        traces = [trace("ev_health", "commerce.inspect_data_health", health)]
        return ({
            "status": "refused",
            "answer": "数据门禁未通过：缺少 visits，停止旗舰诊断，不输出 conversion 结论或行动。",
            "answerClaims": [],
            "findings": [],
            "recommendations": [],
            "followUps": ["等待 visits 数据就绪后重试"],
            "diagnostic": diagnostic_payload(blocked=True),
        }, traces)

    if kind == "review":
        review_rows = [{"period": "baseline", "conversion_rate": 0.031}, {"period": "review", "conversion_rate": 0.034}]
        traces = [trace("ev_review", "commerce.compare_metrics", review_rows)]
        metric_claim = claim("ev_review", "/1/conversion_rate", "conversion_rate", 0.034, "percent")
        return ({
            "status": "answered",
            "answer": "行动后完整窗口观察到转化率提升，但退款率护栏突破，因此整体 verdict 为 guardrail_breached。",
            "answerClaims": [metric_claim],
            "findings": [{
                "metric": "conversion_rate",
                "title": "行动后窗口观察结果",
                "detail": "成功指标改善，但退款率高于冻结护栏；不表述为因果证明。",
                "claims": [metric_claim],
                "insightLevel": "observed",
                "confidence": 0.95,
                "alternatives": ["同期流量结构变化"],
                "contradictionStatus": "clear",
            }],
            "recommendations": [],
            "followUps": [],
        }, traces)

    if kind == "recovered":
        rows = [{"week": "2018-W35", "gmv": 812000}]
        traces = [trace("ev_recovered", "commerce.scan_weekly_kpis", rows)]
        value_claim = claim("ev_recovered", "/0/gmv", "gmv", 812000, "currency")
        return ({
            "status": "answered",
            "answer": "Worker 重领后沿用同一 Job 完成，结果只持久化一次。",
            "answerClaims": [value_claim],
            "findings": [],
            "recommendations": [],
            "followUps": [],
        }, traces)

    weekly_scan = {
        "currentRange": {"start": "2018-05-07", "end": "2018-05-13"},
        "baselineStrategy": "previous_four_complete_weeks_median",
        "signals": [
            {"metric": "gmv", "current": 293731.41, "baselineMedian": 235357.27, "relativeChange": 0.248024},
            {"metric": "paid_orders", "current": 1971, "baselineMedian": 1667.5, "relativeChange": 0.182009},
            {"metric": "visits", "current": 55027, "baselineMedian": 44016.5, "relativeChange": 0.250145},
            {"metric": "conversion_rate", "current": 0.035819, "baselineMedian": 0.038419, "relativeChange": -0.067675},
            {"metric": "average_order_value", "current": 149.0266, "baselineMedian": 141.1431, "relativeChange": 0.055855},
        ],
    }
    channel_rows = [
        {"key": "Organic Search", "current": 128159.34, "baseline": 84153.98, "absoluteChange": 44005.36, "percentChange": 0.522922},
        {"key": "Paid Social", "current": 89893.15, "baseline": 70695.47, "absoluteChange": 19197.68, "percentChange": 0.271555},
        {"key": "Direct", "current": 29051.06, "baseline": 38449.76, "absoluteChange": -9398.70, "percentChange": -0.244441},
        {"key": "Email", "current": 46627.86, "baseline": 52661.02, "absoluteChange": -6033.16, "percentChange": -0.114566},
    ]
    traces = [
        trace("ev_weekly", "commerce.scan_weekly_kpis", weekly_scan, request={"objective": "diagnose_previous_complete_week"}),
        trace(
            "ev_channel",
            "commerce.breakdown_metric",
            channel_rows,
            request={
                "metric": "gmv",
                "dimension": "channel",
                "current": {"start": "2018-05-07", "end": "2018-05-13"},
                "baseline": {"start": "2018-04-30", "end": "2018-05-06"},
            },
        ),
    ]
    gmv_claim = claim("ev_weekly", "/signals/0/current", "gmv", 293731.41, "currency")
    gmv_baseline_claim = claim("ev_weekly", "/signals/0/baselineMedian", "gmv", 235357.27, "currency")
    gmv_change_claim = claim("ev_weekly", "/signals/0/relativeChange", "gmv", 0.248024, "percent")
    orders_change_claim = claim("ev_weekly", "/signals/1/relativeChange", "paid_orders", 0.182009, "percent")
    visits_change_claim = claim("ev_weekly", "/signals/2/relativeChange", "visits", 0.250145, "percent")
    conversion_claim = claim("ev_weekly", "/signals/3/current", "conversion_rate", 0.035819, "percent")
    conversion_change_claim = claim("ev_weekly", "/signals/3/relativeChange", "conversion_rate", -0.067675, "percent")
    aov_change_claim = claim("ev_weekly", "/signals/4/relativeChange", "average_order_value", 0.055855, "percent")
    organic_change_claim = claim("ev_channel", "/0/absoluteChange", "gmv", 44005.36, "currency")
    direct_change_claim = claim("ev_channel", "/2/absoluteChange", "gmv", -9398.70, "currency")
    email_change_claim = claim("ev_channel", "/3/absoluteChange", "gmv", -6033.16, "currency")
    return ({
        "status": "answered",
        "answer": "上一完整周 GMV 为 R$293,731.41，较此前四个完整周中位数增长 24.8%。支付订单增长 18.2%，访问量增长 25.0%，客单价增长 5.6%，但支付转化率下降 6.8%。渠道上 Organic Search 增量最大；Direct 与 Email 是已核验拖累项。",
        "answerClaims": [
            gmv_claim,
            gmv_baseline_claim,
            gmv_change_claim,
            orders_change_claim,
            visits_change_claim,
            conversion_change_claim,
            aov_change_claim,
            organic_change_claim,
            direct_change_claim,
            email_change_claim,
        ],
        "findings": [
            {
                "metric": "gmv",
                "title": "规模判断 · 明确增长周",
                "detail": "GMV 较此前四周中位数增长 24.8%，不是只有当前规模而没有比较基准。",
                "claims": [gmv_claim, gmv_baseline_claim, gmv_change_claim],
                "insightLevel": "driver",
                "confidence": 0.96,
                "alternatives": ["未接入的促销或节假日事件可能影响增幅"],
                "contradictionStatus": "clear",
            },
            {
                "metric": "paid_orders",
                "title": "增长结构 · 订单量主导，客单价协同",
                "detail": "订单与客单价均增长；流量扩张更快，但转化效率承压。",
                "claims": [orders_change_claim, visits_change_claim, conversion_change_claim, aov_change_claim],
                "insightLevel": "contribution",
                "confidence": 0.93,
                "alternatives": ["量价分解不等同于促销因果证明"],
                "contradictionStatus": "clear",
            },
            {
                "metric": "gmv",
                "title": "渠道分化 · Organic Search 增量最大，Direct 拖累最大",
                "detail": "Organic Search 增量 R$44,005.36；Direct 与 Email 分别拖累 R$9,398.70 和 R$6,033.16。",
                "claims": [organic_change_claim, direct_change_claim, email_change_claim],
                "insightLevel": "driver",
                "confidence": 0.94,
                "alternatives": ["渠道归属规则可能影响结构解释"],
                "contradictionStatus": "clear",
            },
        ],
        "recommendations": [{
            "id": "action_weekly_1",
            "action": "复盘 Direct、Email 回落，验证 Organic Search 增量质量",
            "rationale": "先核对活动、流量与商品结构差异，并以支付转化率作为资源调整护栏。",
            "claims": [organic_change_claim, direct_change_claim, email_change_claim, conversion_claim, conversion_change_claim],
            "priority": "high",
            "ownerRole": "growth",
            "deadline": None,
            "successMetric": {
                "metric": "gmv",
                "direction": "increase",
                "baselineClaim": organic_change_claim,
                "target": None,
                "targetUnit": "currency",
                "evaluationWindowDays": None,
            },
            "guardrails": [{
                "metric": "conversion_rate",
                "operator": "not_below",
                "baselineClaim": conversion_claim,
                "threshold": None,
                "unit": "percent",
            }],
            "status": "proposed",
        }],
        "followUps": [],
        "diagnostic": diagnostic_payload(),
    }, traces)


@dataclass
class MockCommerceBackend:
    ready: bool = True
    missing_visits: bool = False
    create_requests: int = 0
    job_reads: int = 0
    event_reads: int = 0
    notification_commands: int = 0
    transitions: list[str] = field(default_factory=list)
    current_action: dict[str, Any] = field(default_factory=lambda: {
        "actionId": "action_weekly_1",
        "status": "proposed",
        "version": 0,
        "updatedAt": NOW,
        "commitment": None,
        "lastNote": None,
        "reminder": {"status": "none", "snoozeUntil": None},
    })
    jobs: dict[str, dict[str, Any]] = field(default_factory=dict)

    def bootstrap(self) -> dict[str, Any]:
        metrics = [metric for metric in CORE_METRICS if not (self.missing_visits and metric == "visits")]
        return {
            "agent": {
                "id": "commerce-data-agent",
                "version": "browser-fixture-v1",
                "runtime": "durable-job",
                "connector": "commerce-data-contract/v1-fixture",
                "fallback": "none",
                "features": {
                    "diagnosticPolicyEnabled": True,
                    "anomalyDetectionEnabled": True,
                    "notificationsEnabled": True,
                    "automaticReviewEnabled": True,
                    "weeklyDiagnosisEnabled": False,
                },
                "models": ["deepseek:deepseek-v4-flash"],
                "tools": ["inspect_commerce_data_health", "scan_weekly_commerce_kpis"],
            },
            "identity": {
                "displayName": "浏览器验收员",
                "authMode": "trusted_proxy",
                "tenantId": "tenant_browser_fixture",
                "userId": "operator_browser_fixture",
                "scopes": ["commerce:data:read", "commerce:actions:write", "commerce:notifications:write"],
            },
            "readiness": {
                "ready": self.ready,
                "issues": [] if self.ready else ["必需来源水位尚未覆盖上一完整周"],
                "warnings": ["固定公开历史快照，不代表实时店铺数据。"] if self.ready else [],
                "databaseConfigured": True,
                "analyticsConfigured": True,
                "modelConfigured": True,
                "authMode": "trusted_proxy",
                "checks": {
                    "configuration": True,
                    "controlSchema": True,
                    "workerActive": True,
                    "analyticsSchema": True,
                    "analyticsReadOnly": True,
                    "analyticsRls": True,
                    "analyticsDataPresent": True,
                    "analyticsDataFresh": self.ready,
                    "analyticsSourceFresh": self.ready,
                },
                "dataStatus": {
                    "dataMode": "snapshot",
                    "snapshotVerified": True,
                    "coverageStart": "2018-01-01",
                    "coverageEnd": "2018-05-20",
                    "businessTimezone": "America/Sao_Paulo",
                    "currencyCode": "BRL",
                    "availableMetrics": metrics,
                    "lastIngestedAt": "2026-08-15T23:00:00.000Z",
                    "sourceUpdatedAt": "2018-10-17T20:30:18.000Z",
                    "sourceDisclosure": {
                        "sourceKind": "public_snapshot",
                        "sourceId": "olist-public-orders",
                        "sourceUri": "https://github.com/olist/work-at-olist-data",
                        "sourceRevision": "d9e49802f3e92d09ee94ab9ccc5e457f207a8959",
                        "licenseId": "MIT",
                        "fixtureSeed": 20260816,
                        "generatedFields": ["visits", "channel", "region", "sku", "category", "units"],
                    },
                },
            },
        }

    @staticmethod
    def _success(route: Route, payload: dict[str, Any], status: int = 200) -> None:
        route.fulfill(
            status=status,
            content_type="application/json; charset=utf-8",
            body=json.dumps({"success": True, **payload}, ensure_ascii=False),
        )

    @staticmethod
    def _request_json(route: Route) -> dict[str, Any]:
        try:
            return route.request.post_data_json or {}
        except Exception:
            return {}

    def _kind(self, message: str) -> str:
        if "趋势" in message:
            return "trend"
        if "缺少 visits" in message or "数据门禁" in message:
            return "blocked"
        if "自动复盘" in message or "护栏" in message:
            return "review"
        if "Worker" in message or "崩溃" in message:
            return "recovered"
        return "diagnosis"

    def _result(self, message: str, suffix: str) -> dict[str, Any]:
        kind = self._kind(message)
        answer, traces = answer_fixture(kind)
        conversation_id = f"conversation_{suffix}"
        summary = {
            "id": conversation_id,
            "title": message[:36],
            "model": "deepseek:deepseek-v4-flash",
            "createdAt": NOW,
            "updatedAt": NOW,
        }
        return {
            "conversation": summary,
            "userMessage": {
                "id": f"message_user_{suffix}",
                "role": "user",
                "content": message,
                "answer": None,
                "runId": f"run_{suffix}",
                "runStatus": "completed",
                "reportAvailable": False,
                "traces": [],
                "createdAt": NOW,
            },
            "assistantMessage": {
                "id": f"message_assistant_{suffix}",
                "role": "assistant",
                "content": answer["answer"],
                "answer": answer,
                "runId": f"run_{suffix}",
                "runStatus": "completed",
                "reportAvailable": False,
                "traces": traces,
                "createdAt": NOW,
            },
            "usage": {"inputTokens": 120, "outputTokens": 80, "totalTokens": 200},
        }

    def _job(self, message: str, *, queued: bool = False) -> dict[str, Any]:
        suffix = str(self.create_requests)
        result = self._result(message, suffix)
        job_id = f"job_{suffix}"
        job = {
            "id": job_id,
            "kind": "create_conversation",
            "conversationId": result["conversation"]["id"],
            "requestId": f"request_{suffix}",
            "model": "deepseek:deepseek-v4-flash",
            "message": message,
            "requiredRevision": "browser-fixture-v1",
            "executedByWorkerId": "worker_replacement" if queued else "worker_primary",
            "status": "queued" if queued else "completed",
            "attemptCount": 2 if queued else 1,
            "maxAttempts": 3,
            "availableAt": NOW,
            "createdAt": NOW,
            "startedAt": NOW,
            "completedAt": None if queued else NOW,
            "result": None if queued else result,
            "error": None,
        }
        completed = {**job, "status": "completed", "completedAt": NOW, "result": result}
        self.jobs[job_id] = completed
        return job

    def _transition(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        next_status = {
            "confirm": "confirmed",
            "start": "in_progress",
            "complete": "completed",
            "block": "blocked",
            "resume": "in_progress",
            "reopen": "reopened",
            "ignore": "ignored",
            "cancel": "cancelled",
        }.get(action, self.current_action["status"])
        self.transitions.append(action)
        self.current_action = {
            **self.current_action,
            "status": next_status,
            "version": self.current_action["version"] + 1,
            "updatedAt": NOW,
            "commitment": body.get("commitment", self.current_action.get("commitment")),
            "lastNote": body.get("note"),
        }
        return self.current_action

    def handle(self, route: Route) -> None:
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        method = request.method.upper()

        if path == "/api/commerce" and method == "GET":
            self._success(route, self.bootstrap())
            return
        if path == "/api/commerce/conversations" and method == "GET":
            self._success(route, {"conversations": []})
            return
        if path == "/api/commerce/jobs" and method == "GET":
            self._success(route, {"jobs": []})
            return
        if path == "/api/commerce/actions" and method == "GET":
            self._success(route, {"actions": []})
            return
        if path == "/api/commerce/members" and method == "GET":
            self._success(route, {"members": [{
                "memberId": "member_growth_owner",
                "displayName": "增长负责人（沙箱）",
                "canReceiveNotifications": True,
            }]})
            return
        if path.endswith("/feedback") and method == "GET":
            self._success(route, {"feedback": None})
            return
        if path == "/api/commerce/conversations" and method == "POST":
            self.create_requests += 1
            message = str(self._request_json(route).get("message", ""))
            queued = self._kind(message) == "recovered"
            self._success(route, {"job": self._job(message, queued=queued)}, status=202)
            return
        if path.endswith("/messages") and method == "POST":
            self.create_requests += 1
            message = str(self._request_json(route).get("message", ""))
            queued = self._kind(message) == "recovered"
            self._success(route, {"job": self._job(message, queued=queued)}, status=202)
            return
        if path.endswith("/events") and "/api/commerce/jobs/" in path:
            self.event_reads += 1
            route.fulfill(
                status=200,
                content_type="text/event-stream; charset=utf-8",
                body="event: completed\ndata: {}\n\n",
            )
            return
        if path.startswith("/api/commerce/jobs/") and method == "GET":
            self.job_reads += 1
            job_id = path.rsplit("/", 1)[-1]
            self._success(route, {"job": self.jobs[job_id]})
            return
        if path.endswith("/notifications") and method == "POST":
            self.notification_commands += 1
            body = self._request_json(route)
            self._success(route, {"notification": {
                "id": "notification_1",
                "actionId": "action_weekly_1",
                "actionVersion": self.current_action["version"],
                "recipientMemberId": body.get("recipientMemberId"),
                "recipientDisplayName": "增长负责人（沙箱）",
                "requestUuid": "00000000-0000-4000-8000-000000000001",
                "status": "pending",
                "providerMessageId": None,
                "createdAt": NOW,
            }}, status=202)
            return
        if "/actions/" in path and method == "PATCH":
            body = self._request_json(route)
            self._success(route, {"actionState": self._transition(str(body.get("action")), body)})
            return

        route.fulfill(
            status=404,
            content_type="application/json; charset=utf-8",
            body=json.dumps({"success": False, "error": "FIXTURE_ROUTE_MISSING", "message": path}),
        )


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_ready(page: Page) -> None:
    page.wait_for_load_state("networkidle")
    page.get_by_label("发送问题").wait_for(state="visible")
    page.wait_for_function(
        "() => { const field = document.querySelector('textarea[placeholder^=\"询问经营数据\"]'); return field && !field.disabled; }"
    )


def composer(page: Page):
    return page.locator("textarea[placeholder^='询问经营数据']")


def send_with_keyboard(page: Page, message: str) -> None:
    field = composer(page)
    field.focus()
    page.keyboard.insert_text(message)
    page.keyboard.press("Enter")


def send_with_button(page: Page, message: str) -> None:
    composer(page).fill(message)
    page.get_by_label("发送问题").click()


def wait_answer(page: Page, text: str) -> None:
    page.locator("[id^='commerce-message-']").get_by_text(text, exact=False).first.wait_for(
        state="visible", timeout=20_000
    )


def flow_weekly_diagnosis(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_keyboard(page, "诊断上一完整周")
    wait_answer(page, "上一完整周 GMV")
    require(page.get_by_label("诊断运行记录").count() == 1, "diagnostic recorder missing")
    require(page.get_by_text("此前四个完整周中位数", exact=True).count() >= 1, "baseline missing")
    require(page.get_by_text("证据已足够", exact=True).count() >= 1, "stop reason missing")
    return {"createRequests": backend.create_requests, "keyboardSubmit": True}


def flow_trend_chart(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_button(page, "查看 GMV 趋势")
    wait_answer(page, "连续 5 天走低")
    if page.viewport_size and page.viewport_size["width"] < 1280:
        page.get_by_label("打开证据面板，共 1 条证据").click()
        evidence_scope = page.get_by_role("dialog", name="证据栏")
    else:
        evidence_scope = page.locator("aside").filter(has_text="证据栏")
    result_toggle = evidence_scope.get_by_role("button", name="核对实际结果")
    if result_toggle.get_attribute("aria-expanded") != "true":
        result_toggle.click()
    evidence_scope.locator("svg.recharts-surface").wait_for(state="visible")
    require(page.get_by_text("峰值 132000", exact=False).count() >= 1, "peak summary missing")
    require(page.get_by_text("谷值 104000", exact=False).count() >= 1, "trough summary missing")
    return {"chart": "line", "createRequests": backend.create_requests}


def flow_readiness_recovery(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    backend.ready = False
    page.reload(wait_until="networkidle")
    page.get_by_text("生产依赖未就绪", exact=True).wait_for(state="visible")
    require(page.locator("textarea:enabled").count() == 0, "composer must stay disabled while data is not ready")
    backend.ready = True
    page.reload(wait_until="networkidle")
    wait_ready(page)
    require(composer(page).is_enabled(), "composer did not recover after readiness")
    return {"blockedThenRecovered": True}


def flow_missing_visits(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    backend.missing_visits = True
    page.reload(wait_until="networkidle")
    send_with_button(page, "数据门禁：缺少 visits 时诊断上一完整周")
    wait_answer(page, "缺少 visits")
    require(page.get_by_text("DATA BLOCKED", exact=True).count() == 1, "blocked health status missing")
    require(page.get_by_text("优先行动", exact=True).count() == 0, "blocked answer must not render an action")
    require(page.get_by_text("conversion 结论或行动", exact=False).count() >= 1, "capability refusal missing")
    return {"actionsRendered": 0, "missingMetric": "visits"}


def flow_evidence_navigation(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_button(page, "诊断上一完整周并定位证据")
    wait_answer(page, "上一完整周 GMV")
    page.get_by_text("查看证据引用（1）", exact=True).first.click()
    page.locator('[aria-label="定位到证据 1"]:visible').first.click()
    target_id = "mobile-evidence-ev_weekly" if page.viewport_size and page.viewport_size["width"] < 1280 else "evidence-ev_weekly"
    page.locator(f"#{target_id}").wait_for(state="visible")
    page.wait_for_function("expected => document.activeElement?.id === expected", arg=target_id)
    focused_id = page.evaluate("document.activeElement && document.activeElement.id")
    require(focused_id == target_id, f"evidence card did not receive focus: {focused_id}")
    return {"focusedEvidenceId": focused_id}


def _confirm_action(page: Page) -> None:
    page.get_by_label("负责人").select_option("member_growth_owner")
    page.get_by_label("截止日").fill("2018-05-25")
    button = page.get_by_role("button", name="确认行动")
    button.focus()
    page.keyboard.press("Enter")
    page.get_by_text("已确认", exact=True).wait_for(state="visible")


def flow_action_notification(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_button(page, "诊断上一完整周并提出行动")
    wait_answer(page, "上一完整周 GMV")
    _confirm_action(page)
    page.get_by_label("飞书收件人").select_option("member_growth_owner")
    send_button = page.get_by_role("button", name="发送飞书")
    send_button.focus()
    page.keyboard.press("Enter")
    wait_answer(page, "逻辑通知已入队")
    require(backend.notification_commands == 1, "exactly one logical notification is required")
    return {
        "recipient": "member_growth_owner",
        "logicalNotificationCommands": backend.notification_commands,
        "keyboardApproval": True,
    }


def flow_complete_and_review(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_button(page, "诊断上一完整周并创建待复盘行动")
    wait_answer(page, "上一完整周 GMV")
    _confirm_action(page)
    page.get_by_role("button", name="开始执行").click()
    page.get_by_text("执行中", exact=True).wait_for(state="visible")
    page.get_by_label("执行备注").fill("历史场景中已完成执行")
    page.get_by_role("button", name="标记完成").click()
    page.get_by_text("已完成", exact=True).wait_for(state="visible")
    send_with_button(page, "自动复盘：成功指标改善但护栏恶化")
    wait_answer(page, "guardrail_breached")
    require(page.get_by_text("行动后窗口观察结果", exact=True).count() >= 1, "review finding missing")
    require(backend.transitions == ["confirm", "start", "complete"], "unexpected action transition sequence")
    return {"transitions": backend.transitions, "verdict": "guardrail_breached"}


def flow_worker_reclaim(page: Page, backend: MockCommerceBackend) -> dict[str, Any]:
    send_with_button(page, "模拟 Worker 崩溃后重领")
    wait_answer(page, "Worker 重领后")
    require(backend.create_requests == 1, "worker reclaim must not create a second job")
    require(backend.event_reads >= 1 and backend.job_reads >= 1, "queued job did not finish through SSE refresh")
    require(page.get_by_text("结果只持久化一次", exact=False).count() == 1, "duplicate assistant result rendered")
    return {
        "createRequests": backend.create_requests,
        "eventReads": backend.event_reads,
        "jobReads": backend.job_reads,
        "renderedResults": 1,
    }


FLOWS: list[tuple[str, Callable[[Page, MockCommerceBackend], dict[str, Any]]]] = [
    ("weekly_diagnosis", flow_weekly_diagnosis),
    ("trend_chart", flow_trend_chart),
    ("data_failure_recovery", flow_readiness_recovery),
    ("missing_visits_gate", flow_missing_visits),
    ("evidence_navigation", flow_evidence_navigation),
    ("action_confirmation_feishu", flow_action_notification),
    ("completed_action_review", flow_complete_and_review),
    ("worker_reclaim", flow_worker_reclaim),
]


def layout_snapshot(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """() => ({
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
        })"""
    )


def axe_scan(page: Page, axe_path: Path) -> list[dict[str, Any]]:
    page.add_script_tag(path=str(axe_path))
    result = page.evaluate(
        """async () => axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          resultTypes: ['violations']
        })"""
    )
    return [
        {
            "id": item["id"],
            "impact": item.get("impact"),
            "description": item["description"],
            "nodes": len(item["nodes"]),
            "targets": [node["target"] for node in item["nodes"][:5]],
        }
        for item in result["violations"]
        if item.get("impact") in {"critical", "serious"}
    ]


def run_flow(browser, origin: str, output: Path, viewport_name: str, flow_name: str, flow) -> dict[str, Any]:
    backend = MockCommerceBackend()
    context = browser.new_context(
        viewport=VIEWPORTS[viewport_name],
        device_scale_factor=1,
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        reduced_motion="reduce",
    )
    page = context.new_page()
    console_errors: list[str] = []
    failed_responses: list[dict[str, Any]] = []
    page_errors: list[str] = []
    page.on(
        "console",
        lambda message: console_errors.append(
            f"{message.text} @ {message.location.get('url', '<unknown>')}"
        ) if message.type == "error" else None,
    )
    page.on(
        "response",
        lambda response: failed_responses.append({"status": response.status, "url": response.url})
        if response.status >= 400 else None,
    )
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.route("**/api/commerce**", backend.handle)
    result: dict[str, Any] = {
        "viewport": viewport_name,
        "flow": flow_name,
        "status": "failed",
    }
    try:
        page.goto(origin, wait_until="networkidle", timeout=60_000)
        wait_ready(page)
        result["assertions"] = flow(page, backend)
        page.wait_for_timeout(100)
        dimensions = layout_snapshot(page)
        require(not dimensions["horizontalOverflow"], f"horizontal overflow: {dimensions}")
        axe_path = ROOT / "node_modules" / "axe-core" / "axe.min.js"
        violations = axe_scan(page, axe_path)
        require(not violations, f"axe critical/serious violations: {violations}")
        require(not console_errors, f"console errors: {console_errors}")
        require(not page_errors, f"uncaught page errors: {page_errors}")
        result.update({
            "status": "passed",
            "layout": dimensions,
            "axeCriticalOrSerious": violations,
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "failedResponses": failed_responses,
        })
        if flow_name == "weekly_diagnosis":
            try:
                page.get_by_label("对话内容").evaluate("element => { element.scrollTop = 0; }")
                page.wait_for_timeout(50)
                page.screenshot(path=str(output / f"{viewport_name}.png"), full_page=False, timeout=10_000)
            except Exception as screenshot_error:
                result["screenshotWarning"] = str(screenshot_error)
    except Exception as error:
        result.update({
            "error": str(error),
            "traceback": traceback.format_exc(),
            "consoleErrors": console_errors,
            "pageErrors": page_errors,
            "failedResponses": failed_responses,
            "layout": layout_snapshot(page),
        })
        try:
            page.screenshot(
                path=str(output / f"failed-{viewport_name}-{flow_name}.png"),
                full_page=False,
                timeout=10_000,
            )
        except Exception as screenshot_error:
            result["screenshotWarning"] = str(screenshot_error)
    finally:
        context.close()
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default=os.environ.get("COMMERCE_BROWSER_E2E_ORIGIN", DEFAULT_ORIGIN))
    parser.add_argument(
        "--output",
        default=os.environ.get("COMMERCE_BROWSER_E2E_OUTPUT", str(ROOT / "tmp" / "commerce-browser-e2e")),
    )
    parser.add_argument("--viewport", choices=[*VIEWPORTS, "all"], default="all")
    parser.add_argument("--flow", choices=[*[name for name, _ in FLOWS], "all"], default="all")
    parser.add_argument(
        "--server-mode",
        choices=("development", "production"),
        default=os.environ.get("COMMERCE_BROWSER_E2E_SERVER_MODE", "development"),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    axe_path = ROOT / "node_modules" / "axe-core" / "axe.min.js"
    if not axe_path.is_file():
        print("axe-core is missing; run npm ci before the browser gate.", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser_version = browser.version
        selected_viewports = VIEWPORTS if args.viewport == "all" else [args.viewport]
        selected_flows = FLOWS if args.flow == "all" else [entry for entry in FLOWS if entry[0] == args.flow]
        for viewport_name in selected_viewports:
            for flow_name, flow in selected_flows:
                result = run_flow(browser, args.origin, output, viewport_name, flow_name, flow)
                results.append(result)
                status = "PASS" if result["status"] == "passed" else "FAIL"
                print(f"[commerce-browser-e2e] {status} {viewport_name}/{flow_name}")
                if result["status"] != "passed":
                    print(f"[commerce-browser-e2e] reason: {result.get('error')}", file=sys.stderr)
        browser.close()

    failed = [result for result in results if result["status"] != "passed"]
    axe_version = json.loads((ROOT / "node_modules" / "axe-core" / "package.json").read_text(encoding="utf-8"))["version"]
    report = {
        "schemaVersion": 1,
        "service": "commerce-data-agent",
        "revision": os.environ.get("COMMERCE_RELEASE_REVISION", "unversioned"),
        "generatedAt": datetime.now(UTC).isoformat(),
        "status": "failed" if failed else "passed",
        "origin": args.origin,
        "serverMode": args.server_mode,
        "browser": {"engine": "chromium", "version": browser_version, "headless": True},
        "axeCoreVersion": axe_version,
        "fixture": "stateful-browser-api-v1",
        "scope": {
            "ui": "real Next.js application",
            "api": "deterministic in-browser route fixture",
            "doesNotProve": ["real model behavior", "database integration", "actual Feishu delivery", "physical exactly-once"],
        },
        "environmentFlowCount": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "results": results,
    }
    report_path = output / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[commerce-browser-e2e] report={report_path}")
    if failed:
        for result in failed:
            print(
                f"[commerce-browser-e2e] FAIL {result['viewport']}/{result['flow']}: {result.get('error')}",
                file=sys.stderr,
            )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
