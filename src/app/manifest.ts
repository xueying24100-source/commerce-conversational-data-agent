import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Commerce Conversational Data Agent',
    short_name: 'Commerce Agent',
    description: '基于租户真实经营数据进行多轮分析，并返回可追溯证据。',
    start_url: '/commerce',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#1d4ed8',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
      },
    ],
  };
}
