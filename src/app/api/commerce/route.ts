import { NextResponse, type NextRequest } from 'next/server';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import {
  configuredCommerceModels,
  getCommerceAgentRuntimeConfig,
} from '@/lib/domains/commerce/agent/config';
import { checkCommerceReadiness } from '@/lib/domains/commerce/agent/readiness';
import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
} from '@/lib/constants/models';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    const readiness = await checkCommerceReadiness(identity.tenantId);
    const config = getCommerceAgentRuntimeConfig();
    return NextResponse.json({
      success: true,
      agent: {
        id: 'commerce.conversational-data-agent',
        version: '4.0.0',
        revision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
        runtime: 'moagent-tool-loop',
        connector: 'postgresql-readonly',
        sessionStore: 'postgresql',
        fallback: 'disabled',
        features: {
          diagnosticPolicyEnabled: config.diagnosticPolicyEnabled,
          anomalyDetectionEnabled: config.anomalyDetectionEnabled,
          notificationsEnabled: config.notificationsEnabled,
          automaticReviewEnabled: config.automaticReviewEnabled,
          weeklyDiagnosisEnabled: config.weeklyDiagnosisEnabled,
        },
        models: configuredCommerceModels().length
          ? configuredCommerceModels()
          : [LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID, DEEPSEEK_MODEL_ID],
        tools: [
          'describe_commerce_data',
          'inspect_commerce_data_health',
          'scan_weekly_commerce_kpis',
          'lookup_commerce_entities',
          'compare_commerce_metrics',
          'breakdown_commerce_metric',
          'trend_commerce_metric',
          'find_inventory_risk',
          'submit_grounded_commerce_answer',
        ],
      },
      identity: {
        displayName: identity.displayName,
        authMode: identity.authMode,
        tenantId: identity.tenantId,
        userId: identity.userId,
        scopes: identity.scopes,
      },
      readiness: {
        ...readiness.configuration,
        ready: readiness.ready,
        issues: readiness.issues,
        warnings: readiness.warnings,
        checks: readiness.checks,
        dataStatus: readiness.dataStatus,
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return commerceApiError(error);
  }
}

export function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'LEGACY_ENDPOINT_REMOVED',
      message: '固定诊断 POST 已移除，请使用 /api/commerce/conversations。',
    },
    { status: 410 },
  );
}
