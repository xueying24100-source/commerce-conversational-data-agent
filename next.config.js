const isStandaloneBuild = process.env.COMMERCE_STANDALONE_BUILD === '1';
const enableHsts = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_SECURITY_HSTS || '');
const projectRoot = __dirname;
const skipRouteOutputTracing = process.env.COMMERCE_SKIP_ROUTE_TRACING !== '0' && !isStandaloneBuild;
const tracingExcludes = [
  './.env',
  './.env.*',
  './**/.env',
  './**/.env.*',
  './**/.npmrc',
  './**/.netrc',
  './**/*.key',
  './**/*.pem',
  './.git/**',
  './.next/**',
  './.turbo/**',
  './data/**',
  './tmp/**',
  './coverage/**',
  './dist/**',
  './build/**',
  './out/**',
  './node_modules/.cache/**',
];
const tracePluginIgnores = [
  '**/.env',
  '**/.env.*',
  '**/.npmrc',
  '**/.netrc',
  '**/*.key',
  '**/*.pem',
  '**/.git/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/data/**',
  '**/tmp/**',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ['127.0.0.1'],
  ...(isStandaloneBuild ? { output: 'standalone' } : {}),
  // 关闭 critters 的 CSS 优化，避免构建时缺少可选依赖。
  experimental: {
    optimizeCss: false,
  },
  // Next 16 defaults dev mode to Turbopack and errors when a webpack() hook
  // exists without a turbopack key.
  turbopack: {},
  outputFileTracingRoot: projectRoot,
  // 工作区数据、历史项目、本地缓存和 Git 元数据不属于构建产物，避免 trace 扫全仓库。
  outputFileTracingExcludes: {
    '*': tracingExcludes,
    '/api/**': tracingExcludes,
  },
  webpack(config, { isServer }) {
    if (isServer) {
      config.plugins = (config.plugins || []).filter((plugin) => {
        if (plugin?.constructor?.name !== 'TraceEntryPointsPlugin') {
          return true;
        }
        if (skipRouteOutputTracing) {
          // Next 16 requires proxy.js.nft.json during finalization even for a
          // non-standalone build. Keep the plugin so it emits the trace files,
          // but ignore dependencies to preserve the fast non-standalone path.
          plugin.traceIgnores.push('**/*');
          return true;
        }
        if (Array.isArray(plugin.traceIgnores)) {
          plugin.traceIgnores.push(...tracePluginIgnores);
        }
        return true;
      });
    }
    return config;
  },
  async redirects() {
    return [
      { source: '/', destination: '/commerce', permanent: false },
    ];
  },
  async headers() {
    const securityHeaders = [
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      ...(enableHsts
        ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
        : []),
    ];
    return [
      { source: '/:path*', headers: securityHeaders },
    ];
  },
};

module.exports = nextConfig;
