function positiveInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function positiveDecimal(name: string, min: number, max: number): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

const PLACEHOLDER_SECRET = /(?:replace|change[-_ ]?me|example|your[-_ ]?(?:key|secret)|at[-_ ]least[-_ ]32|random[-_ ]characters)/iu;

export function isConfiguredCommerceCredential(
  value: string | null | undefined,
): value is string {
  const normalized = value?.trim() || '';
  return normalized.length >= 8 && !PLACEHOLDER_SECRET.test(normalized);
}

export function isValidTrustedProxySecret(
  value: string | null | undefined,
): value is string {
  const normalized = value?.trim() || '';
  return /^[A-Za-z0-9_-]{43,128}$/u.test(normalized)
    && !PLACEHOLDER_SECRET.test(normalized);
}

function isValidProductionOrigin(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.origin === value
      && !parsed.username
      && !parsed.password
      && !/(?:^|\.)example\.(?:com|org|net)$/iu.test(parsed.hostname);
  } catch {
    return false;
  }
}

function postgresUsername(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && parsed.hostname
      && parsed.username
      ? decodeURIComponent(parsed.username)
      : null;
  } catch {
    return null;
  }
}

function isHttpsUrl(value: string | undefined): boolean {
  try {
    return new URL(value || '').protocol === 'https:';
  } catch {
    return false;
  }
}

function isStableScope(value: string | undefined): boolean {
  const normalized = value?.trim() || '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(normalized)
    && !PLACEHOLDER_SECRET.test(normalized);
}

function isReleaseRevision(value: string | undefined): boolean {
  const normalized = value?.trim() || '';
  return /^[A-Za-z0-9._-]{7,64}$/u.test(normalized)
    && normalized !== 'unversioned'
    && !PLACEHOLDER_SECRET.test(normalized);
}

export interface CommerceAgentRuntimeConfig {
  publicOrigin: string | null;
  databaseUrl: string | null;
  controlRuntimeRole: 'web' | 'worker';
  analyticsDatabaseUrl: string | null;
  trustedProxySecret: string | null;
  developmentAuthBypass: boolean;
  developmentTenantId: string;
  developmentUserId: string;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxInputTokens: number;
  maxPreparedInputTokens: number;
  timeoutMs: number;
  rateLimitPerMinute: number;
  tenantRateLimitPerMinute: number;
  globalConcurrencyLimit: number;
  tenantConcurrencyLimit: number;
  conversationHistoryLimit: number;
  conversationHistoryChars: number;
  catalogPreviewLimit: number;
  pgSsl: boolean;
  pgPoolMax: number;
  pgRejectUnauthorized: boolean;
  pgCa: string | null;
  maxDataAgeHours: number;
  jobLeaseMs: number;
  jobPollMs: number;
  jobRetryBaseMs: number;
  jobRetryMaxMs: number;
  maxQueuedJobsPerUser: number;
  accountHourlyDiagnosisLimit: number;
  ipHourlyDiagnosisLimit: number;
  jobMaxAttempts: number;
  workerStaleMs: number;
  metricsToken: string | null;
  diagnosticPolicyEnabled: boolean;
  anomalyDetectionEnabled: boolean;
  weeklyDiagnosisEnabled: boolean;
  notificationsEnabled: boolean;
  automaticReviewEnabled: boolean;
  globalKillSwitch: boolean;
  feishuAppId: string | null;
  feishuAppSecret: string | null;
  feishuBaseUrl: string;
  dailyModelBudgetUsd: number | null;
  modelInputUsdPerMillionTokens: number | null;
  modelOutputUsdPerMillionTokens: number | null;
}

export interface CommerceModelBudgetPolicy {
  dailyLimitUsd: number;
  reservationUsd: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export class CommerceModelBudgetConfigurationError extends Error {
  readonly code = 'COMMERCE_MODEL_BUDGET_NOT_CONFIGURED';
  readonly status = 503;

  constructor(message = '模型日预算已启用，但缺少有效的输入或输出 token 单价。') {
    super(message);
    this.name = 'CommerceModelBudgetConfigurationError';
  }
}

function roundUsdUp(value: number): number {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

export function commerceModelBudgetPolicy(
  config: CommerceAgentRuntimeConfig = getCommerceAgentRuntimeConfig(),
): CommerceModelBudgetPolicy | null {
  if (config.dailyModelBudgetUsd === null) {
    if (process.env.DAILY_MODEL_BUDGET_USD?.trim()) {
      throw new CommerceModelBudgetConfigurationError(
        'DAILY_MODEL_BUDGET_USD 必须是大于 0 的有限数值。',
      );
    }
    return null;
  }
  if (
    config.modelInputUsdPerMillionTokens === null
    || config.modelOutputUsdPerMillionTokens === null
  ) {
    throw new CommerceModelBudgetConfigurationError();
  }
  // The configured prices are deployment-wide conservative ceilings across all
  // enabled model profiles. Reserve the hard run envelope before enqueue. This is based on
  // prepared input rather than the softer provider-reported input budget, so a
  // response that crosses the latter cannot make the daily ledger overspend.
  const reservationUsd = roundUsdUp(
    (
      config.maxPreparedInputTokens * config.modelInputUsdPerMillionTokens
      + config.maxOutputTokens * config.modelOutputUsdPerMillionTokens
    ) / 1_000_000,
  );
  if (!(reservationUsd > 0)) {
    throw new CommerceModelBudgetConfigurationError(
      '模型日预算已启用，但计算出的单 Run 预算预留金额无效。',
    );
  }
  return {
    dailyLimitUsd: config.dailyModelBudgetUsd,
    reservationUsd,
    inputUsdPerMillionTokens: config.modelInputUsdPerMillionTokens,
    outputUsdPerMillionTokens: config.modelOutputUsdPerMillionTokens,
  };
}

export function getCommerceAgentRuntimeConfig(): CommerceAgentRuntimeConfig {
  const requestedRuntimeRole = process.env.COMMERCE_RUNTIME_ROLE?.trim().toLowerCase();
  const controlRuntimeRole = requestedRuntimeRole === 'worker' ? 'worker' : 'web';
  const legacyDatabaseUrl = process.env.COMMERCE_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim()
    || null;
  const databaseUrl = (controlRuntimeRole === 'worker'
    ? process.env.COMMERCE_CONTROL_WORKER_DATABASE_URL?.trim()
    : process.env.COMMERCE_CONTROL_API_DATABASE_URL?.trim())
    || (process.env.NODE_ENV === 'production' ? null : legacyDatabaseUrl);
  const analyticsDatabaseUrl = process.env.COMMERCE_ANALYTICS_DATABASE_URL?.trim()
    || (process.env.NODE_ENV === 'production' ? null : databaseUrl);
  const pgPoolMax = positiveInteger('COMMERCE_PG_POOL_MAX', 10, 3, 50);
  const globalConcurrencyLimit = positiveInteger(
    'COMMERCE_AGENT_GLOBAL_CONCURRENCY',
    Math.max(1, pgPoolMax - 2),
    1,
    48,
  );
  return {
    publicOrigin: process.env.COMMERCE_PUBLIC_ORIGIN?.trim()?.replace(/\/$/u, '') || null,
    databaseUrl,
    controlRuntimeRole,
    analyticsDatabaseUrl,
    trustedProxySecret: process.env.COMMERCE_TRUSTED_PROXY_SECRET?.trim() || null,
    developmentAuthBypass: flag('COMMERCE_DEV_AUTH_BYPASS', false),
    developmentTenantId: process.env.COMMERCE_DEV_TENANT_ID?.trim() || 'tenant_local',
    developmentUserId: process.env.COMMERCE_DEV_USER_ID?.trim() || 'user_local',
    maxTurns: positiveInteger('COMMERCE_AGENT_MAX_TURNS', 8, 2, 16),
    maxToolCalls: positiveInteger('COMMERCE_AGENT_MAX_TOOL_CALLS', 12, 2, 32),
    maxOutputTokens: positiveInteger('COMMERCE_AGENT_MAX_OUTPUT_TOKENS', 12_000, 1_000, 20_000),
    maxInputTokens: positiveInteger('COMMERCE_AGENT_MAX_INPUT_TOKENS', 80_000, 8_000, 200_000),
    maxPreparedInputTokens: positiveInteger(
      'COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS',
      400_000,
      16_000,
      400_000,
    ),
    timeoutMs: positiveInteger('COMMERCE_AGENT_TIMEOUT_MS', 60_000, 5_000, 120_000),
    rateLimitPerMinute: positiveInteger('COMMERCE_AGENT_RATE_LIMIT_PER_MINUTE', 20, 1, 240),
    tenantRateLimitPerMinute: positiveInteger(
      'COMMERCE_AGENT_TENANT_RATE_LIMIT_PER_MINUTE',
      200,
      1,
      10_000,
    ),
    globalConcurrencyLimit,
    tenantConcurrencyLimit: positiveInteger(
      'COMMERCE_AGENT_TENANT_CONCURRENCY',
      Math.min(4, globalConcurrencyLimit),
      1,
      100,
    ),
    conversationHistoryLimit: positiveInteger('COMMERCE_AGENT_HISTORY_MESSAGES', 24, 4, 80),
    conversationHistoryChars: positiveInteger('COMMERCE_AGENT_HISTORY_CHARS', 48_000, 8_000, 200_000),
    catalogPreviewLimit: positiveInteger('COMMERCE_CATALOG_PREVIEW_LIMIT', 100, 1, 100),
    pgSsl: flag('COMMERCE_PG_SSL', process.env.NODE_ENV === 'production'),
    pgPoolMax,
    pgRejectUnauthorized: flag('COMMERCE_PG_REJECT_UNAUTHORIZED', true),
    pgCa: process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim() || null,
    maxDataAgeHours: positiveInteger('COMMERCE_MAX_DATA_AGE_HOURS', 72, 1, 8_760),
    jobLeaseMs: positiveInteger('COMMERCE_JOB_LEASE_MS', 150_000, 30_000, 600_000),
    jobPollMs: positiveInteger('COMMERCE_JOB_POLL_MS', 1_000, 100, 30_000),
    jobRetryBaseMs: positiveInteger('COMMERCE_JOB_RETRY_BASE_MS', 2_000, 100, 60_000),
    jobRetryMaxMs: positiveInteger('COMMERCE_JOB_RETRY_MAX_MS', 60_000, 1_000, 600_000),
    maxQueuedJobsPerUser: positiveInteger('COMMERCE_MAX_QUEUED_JOBS_PER_USER', 2, 1, 100),
    accountHourlyDiagnosisLimit: positiveInteger('COMMERCE_ACCOUNT_HOURLY_DIAGNOSIS_LIMIT', 5, 1, 1_000),
    ipHourlyDiagnosisLimit: positiveInteger('COMMERCE_IP_HOURLY_DIAGNOSIS_LIMIT', 20, 1, 10_000),
    jobMaxAttempts: positiveInteger('COMMERCE_JOB_MAX_ATTEMPTS', 3, 1, 10),
    workerStaleMs: positiveInteger('COMMERCE_WORKER_STALE_MS', 30_000, 5_000, 300_000),
    metricsToken: process.env.COMMERCE_METRICS_TOKEN?.trim() || null,
    diagnosticPolicyEnabled: flag('COMMERCE_DIAGNOSTIC_POLICY_ENABLED', true),
    anomalyDetectionEnabled: flag('COMMERCE_ANOMALY_DETECTION_ENABLED', true),
    weeklyDiagnosisEnabled: flag('COMMERCE_WEEKLY_DIAGNOSIS_ENABLED', false),
    notificationsEnabled: flag('COMMERCE_FEISHU_NOTIFICATIONS_ENABLED', false),
    automaticReviewEnabled: flag('COMMERCE_AUTOMATIC_REVIEW_ENABLED', false),
    globalKillSwitch: flag('COMMERCE_GLOBAL_KILL_SWITCH', false),
    feishuAppId: process.env.COMMERCE_FEISHU_APP_ID?.trim() || null,
    feishuAppSecret: process.env.COMMERCE_FEISHU_APP_SECRET?.trim() || null,
    feishuBaseUrl: process.env.COMMERCE_FEISHU_BASE_URL?.trim().replace(/\/$/u, '')
      || 'https://open.feishu.cn',
    dailyModelBudgetUsd: positiveDecimal(
      'DAILY_MODEL_BUDGET_USD',
      0.00000001,
      9_999_999_999.99999999,
    ),
    modelInputUsdPerMillionTokens: positiveDecimal(
      'COMMERCE_MODEL_INPUT_USD_PER_MILLION_TOKENS',
      0.000001,
      1_000_000,
    ),
    modelOutputUsdPerMillionTokens: positiveDecimal(
      'COMMERCE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS',
      0.000001,
      1_000_000,
    ),
  };
}

export function configuredCommerceModels(): MoAgentModelId[] {
  const models: MoAgentModelId[] = [];
  if (isConfiguredCommerceCredential(process.env.MODELPORT_API_KEY)) {
    models.push(LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID);
  }
  if (isConfiguredCommerceCredential(process.env.DEEPSEEK_API_KEY)) {
    models.push(DEEPSEEK_MODEL_ID);
  }
  return models;
}

export function commerceConfigurationStatus() {
  const config = getCommerceAgentRuntimeConfig();
  const agentEnabled = flag('COMMERCE_LLM_AGENT_ENABLED', true);
  const modelConfigured = agentEnabled && configuredCommerceModels().length > 0;
  const issues: string[] = [];
  if (config.globalConcurrencyLimit > config.pgPoolMax - 2) {
    issues.push(
      'COMMERCE_AGENT_GLOBAL_CONCURRENCY 必须至少为分析连接池预留 2 个连接。',
    );
  }
  if (config.tenantConcurrencyLimit > config.globalConcurrencyLimit) {
    issues.push(
      'COMMERCE_AGENT_TENANT_CONCURRENCY 不能大于 COMMERCE_AGENT_GLOBAL_CONCURRENCY。',
    );
  }
  if (config.maxPreparedInputTokens < config.maxInputTokens) {
    issues.push(
      'COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS 不能小于 COMMERCE_AGENT_MAX_INPUT_TOKENS。',
    );
  }
  if (config.jobRetryMaxMs < config.jobRetryBaseMs) {
    issues.push('COMMERCE_JOB_RETRY_MAX_MS 不能小于 COMMERCE_JOB_RETRY_BASE_MS。');
  }
  if (!config.databaseUrl) {
    issues.push(config.controlRuntimeRole === 'worker'
      ? '缺少 COMMERCE_CONTROL_WORKER_DATABASE_URL。'
      : '缺少 COMMERCE_CONTROL_API_DATABASE_URL。');
  }
  if (!config.analyticsDatabaseUrl) issues.push('缺少 COMMERCE_ANALYTICS_DATABASE_URL。');
  if (!modelConfigured) issues.push('缺少 MODELPORT_API_KEY 或 DEEPSEEK_API_KEY。');
  if (!agentEnabled) issues.push('COMMERCE_LLM_AGENT_ENABLED 已关闭。');
  if (config.weeklyDiagnosisEnabled && !config.diagnosticPolicyEnabled) {
    issues.push('开启周诊断调度必须同时开启 COMMERCE_DIAGNOSTIC_POLICY_ENABLED。');
  }
  if (config.weeklyDiagnosisEnabled && !config.anomalyDetectionEnabled) {
    issues.push('开启周诊断调度必须同时开启 COMMERCE_ANOMALY_DETECTION_ENABLED。');
  }
  if (config.notificationsEnabled) {
    if (!isConfiguredCommerceCredential(config.feishuAppId)) {
      issues.push('开启飞书通知需要 COMMERCE_FEISHU_APP_ID。');
    }
    if (!isConfiguredCommerceCredential(config.feishuAppSecret)) {
      issues.push('开启飞书通知需要 COMMERCE_FEISHU_APP_SECRET。');
    }
    if (!(process.env.COMMERCE_FEISHU_OPERATOR_ALLOWLIST?.trim())) {
      issues.push('开启飞书通知需要 COMMERCE_FEISHU_OPERATOR_ALLOWLIST。');
    }
  }
  try {
    commerceModelBudgetPolicy(config);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : '模型预算定价配置无效。');
  }
  if (process.env.NODE_ENV === 'production') {
    const declaredRuntimeRole = process.env.COMMERCE_RUNTIME_ROLE?.trim().toLowerCase();
    if (declaredRuntimeRole !== 'web' && declaredRuntimeRole !== 'worker') {
      issues.push('生产环境必须将 COMMERCE_RUNTIME_ROLE 显式设为 web 或 worker。');
    }
    if (config.dailyModelBudgetUsd === null) {
      issues.push('生产环境必须设置正数 DAILY_MODEL_BUDGET_USD。');
    }
    if (!isReleaseRevision(process.env.COMMERCE_RELEASE_REVISION)) {
      issues.push('生产环境需要不可变的 COMMERCE_RELEASE_REVISION。');
    }
    if (!isValidProductionOrigin(config.publicOrigin)) {
      issues.push('生产环境需要真实 HTTPS origin 形式的 COMMERCE_PUBLIC_ORIGIN。');
    }
    if (!isValidTrustedProxySecret(config.trustedProxySecret)) {
      issues.push('生产环境需要 43-128 字符 base64url 格式的随机 COMMERCE_TRUSTED_PROXY_SECRET。');
    }
    if (!config.metricsToken || config.metricsToken.length < 32 || PLACEHOLDER_SECRET.test(config.metricsToken)) {
      issues.push('生产环境需要至少 32 字符的 COMMERCE_METRICS_TOKEN。');
    }
    if (config.databaseUrl && config.analyticsDatabaseUrl === config.databaseUrl) {
      issues.push('生产环境控制库与只读分析库必须使用不同连接凭据。');
    }
    const controlUser = postgresUsername(config.databaseUrl);
    const analyticsUser = postgresUsername(config.analyticsDatabaseUrl);
    if (config.databaseUrl && !controlUser) {
      issues.push('Control runtime database URL 必须是有效 PostgreSQL URL。');
    }
    const expectedControlUser = config.controlRuntimeRole === 'worker'
      ? 'commerce_control_worker_user'
      : 'commerce_control_api_user';
    if (controlUser && controlUser !== expectedControlUser) {
      issues.push(`Control runtime database URL 必须使用 ${expectedControlUser}。`);
    }
    if (config.analyticsDatabaseUrl && !analyticsUser) {
      issues.push('COMMERCE_ANALYTICS_DATABASE_URL 必须是有效 PostgreSQL URL。');
    }
    if (controlUser && analyticsUser && controlUser === analyticsUser) {
      issues.push('生产环境控制库与分析库必须使用不同数据库角色。');
    }
    if (isConfiguredCommerceCredential(process.env.MODELPORT_API_KEY)) {
      if (!isHttpsUrl(process.env.COMMERCE_MODELPORT_URL)) {
        issues.push('生产 ModelPort 必须显式配置 HTTPS COMMERCE_MODELPORT_URL。');
      }
      for (const name of [
        'COMMERCE_MODELPORT_ORGANIZATION_ID',
        'COMMERCE_MODELPORT_PROJECT_ID',
        'COMMERCE_MODELPORT_ENVIRONMENT_ID',
      ]) {
        if (!isStableScope(process.env[name])) {
          issues.push(`生产 ModelPort 需要显式、稳定的 ${name}。`);
        }
      }
    }
    if (config.developmentAuthBypass) issues.push('生产环境不能开启 COMMERCE_DEV_AUTH_BYPASS。');
    if (!config.pgSsl) issues.push('生产环境必须开启 COMMERCE_PG_SSL。');
    if (!config.pgRejectUnauthorized) {
      issues.push('生产环境必须开启 COMMERCE_PG_REJECT_UNAUTHORIZED。');
    }
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
      issues.push('生产环境禁止 NODE_TLS_REJECT_UNAUTHORIZED=0。');
    }
  }
  return {
    ready: issues.length === 0,
    issues,
    databaseConfigured: Boolean(config.databaseUrl),
    analyticsConfigured: Boolean(config.analyticsDatabaseUrl),
    modelConfigured,
    authMode: config.developmentAuthBypass ? 'development' as const : 'trusted_proxy' as const,
  };
}
import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
  type MoAgentModelId,
} from '@/lib/constants/models';
