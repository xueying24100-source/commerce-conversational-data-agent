import {
  DeepSeekProvider,
  type DeepSeekProviderOptions,
} from '@/lib/agent/providers/deepseek';
import { OpenAICompatibleProvider } from '@/lib/agent/providers/openai-compatible';
import type { MoAgentModelProvider } from '@/lib/agent/types';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
  type MoAgentModelId,
} from '@/lib/constants/models';
import { isConfiguredCommerceCredential } from './config';

function scopeHeader(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)
    ? normalized
    : fallback;
}

function modelPortBaseUrl(configured: string): string {
  const fromEnvironment = process.env.COMMERCE_MODELPORT_URL?.trim();
  const base = (fromEnvironment || configured).replace(/\/+$/u, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

export class CommerceModelConfigurationError extends Error {
  readonly code = 'COMMERCE_MODEL_NOT_CONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'CommerceModelConfigurationError';
  }
}

export interface CommerceModelRuntime {
  provider: MoAgentModelProvider;
  providerName: string;
  model: string;
}

export function resolveCommerceModelSelection(requestedModel: string): {
  model: MoAgentModelId;
  providerName: 'deepseek' | 'modelport';
} {
  const supported: readonly string[] = [
    LOCAL_QWEN_MODEL_ID,
    MODELPORT_DEEPSEEK_MODEL_ID,
    DEEPSEEK_MODEL_ID,
  ];
  if (!supported.includes(requestedModel)) {
    throw new CommerceModelConfigurationError('请求的 Commerce 模型 profile 不受支持。');
  }
  return {
    model: requestedModel as MoAgentModelId,
    providerName: requestedModel === DEEPSEEK_MODEL_ID ? 'deepseek' : 'modelport',
  };
}

export function createCommerceModelRuntime(requestedModel?: string | null): CommerceModelRuntime {
  if (requestedModel) resolveCommerceModelSelection(requestedModel);
  const config = getProjectLlmConfig(requestedModel);
  if (!config.agent.enabled) {
    throw new CommerceModelConfigurationError('Commerce Data Agent 的 LLM runtime 已被服务端禁用。');
  }
  const apiKey = process.env[config.credentialEnv]?.trim();
  if (!isConfiguredCommerceCredential(apiKey)) {
    throw new CommerceModelConfigurationError(
      `缺少 ${config.credentialEnv}，生产 Agent 不会切换到规则或 Fixture fallback。`,
    );
  }
  const baseUrl = config.provider === 'openai'
    ? modelPortBaseUrl(config.baseUrl)
    : config.baseUrl;
  if (process.env.NODE_ENV === 'production') {
    try {
      if (new URL(baseUrl).protocol !== 'https:') throw new Error('not HTTPS');
    } catch {
      throw new CommerceModelConfigurationError(
        '生产环境模型 Provider 必须使用有效的 HTTPS URL。',
      );
    }
  }
  const options: DeepSeekProviderOptions = {
    apiKey,
    baseUrl,
    headers: {
      'X-Client-App': 'Commerce-Data-Agent/4',
      ...(config.provider === 'openai'
        ? {
            'X-ModelPort-Organization-Id': scopeHeader(
              process.env.COMMERCE_MODELPORT_ORGANIZATION_ID,
              'org_commerce',
            ),
            'X-ModelPort-Project-Id': scopeHeader(
              process.env.COMMERCE_MODELPORT_PROJECT_ID,
              'prj_commerce_agent',
            ),
            'X-ModelPort-Environment-Id': scopeHeader(
              process.env.COMMERCE_MODELPORT_ENVIRONMENT_ID,
              process.env.NODE_ENV === 'production' ? 'env_production' : 'env_development',
            ),
          }
        : {}),
    },
    maxRequestBytes: 1_000_000,
    maxTextChars: 24_000,
    maxReasoningChars: 4_000,
    maxToolArgumentChars: 32_000,
    maxToolCalls: 4,
    maxRetries: config.queryRewrite.maxRetries,
    initialRetryDelayMs: 300,
    maxRetryDelayMs: 1_500,
  };
  const provider = config.provider === 'deepseek'
    ? new DeepSeekProvider(options)
    : new OpenAICompatibleProvider({ ...options, providerName: 'modelport' });
  return {
    provider,
    providerName: provider.name,
    model: config.model,
  };
}
