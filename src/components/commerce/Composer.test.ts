import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from './Composer';

describe('Commerce Composer input boundary', () => {
  it('advertises the same 2,000-character ceiling enforced by the API and queue', () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      draft: '诊断上一完整周经营表现',
      onDraftChange: vi.fn(),
      onKeyDown: vi.fn(),
      onSubmit: vi.fn(),
      sending: false,
      ready: true,
      error: null,
      isNewConversation: true,
      model: 'deepseek-v4-flash',
      availableModels: ['deepseek-v4-flash'],
      onModelChange: vi.fn(),
    }));

    expect(html).toContain('maxLength="2000"');
  });
});
