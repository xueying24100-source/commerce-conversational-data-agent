'use client';

import {
  Check,
  Clipboard,
  Download,
  ExternalLink,
  FileJson,
  FileText,
  Link,
  Link2Off,
  LoaderCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface ReportShare {
  id: string;
  url: string;
  expiresAt: string;
}

export function ReportDownload({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<ReportShare | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const baseUrl = `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/report`;
  const shareBaseUrl = `${baseUrl}/shares`;

  async function createShare() {
    setShareBusy(true);
    setShareMessage(null);
    try {
      const response = await fetch(shareBaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInHours: 24 }),
      });
      const payload = await response.json() as {
        success?: boolean;
        share?: { id: string; url: string; expiresAt: string };
        message?: string;
      };
      if (!response.ok || !payload.success || !payload.share?.url) {
        throw new Error(payload.message || '无法创建分享链接。');
      }
      setShare(payload.share);
      setShareMessage('链接已创建');
      try {
        await navigator.clipboard.writeText(payload.share.url);
        setShareMessage('链接已创建并复制');
      } catch {
        // Clipboard permission is optional; the link remains available to open.
      }
    } catch (error) {
      setShareMessage(error instanceof Error ? error.message : '无法创建分享链接。');
    } finally {
      setShareBusy(false);
    }
  }

  async function copyShare() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setShareMessage('链接已复制');
    } catch {
      setShareMessage('复制失败，请打开链接后从地址栏复制。');
    }
  }

  async function revokeShare() {
    if (!share) return;
    setShareBusy(true);
    setShareMessage(null);
    try {
      const response = await fetch(`${shareBaseUrl}/${encodeURIComponent(share.id)}`, {
        method: 'DELETE',
      });
      const payload = await response.json() as { success?: boolean; message?: string };
      if (!response.ok || !payload.success) throw new Error(payload.message || '无法撤销分享链接。');
      setShare(null);
      setShareMessage('链接已撤销');
    } catch (error) {
      setShareMessage(error instanceof Error ? error.message : '无法撤销分享链接。');
    } finally {
      setShareBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    function close(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="下载审计报告"
        aria-haspopup="menu"
        aria-expanded={open}
        title="下载审计报告"
        onClick={() => setOpen((current) => !current)}
        className="grid h-8 w-8 place-items-center rounded-md border border-violet-200 bg-white text-indigo-600 transition hover:border-violet-300 hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
      >
        <Download className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-10 right-0 z-20 w-72 overflow-hidden rounded-md border border-violet-100 bg-white py-1 shadow-lg"
        >
          <a
            role="menuitem"
            href={`${baseUrl}?format=json`}
            download
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-indigo-800 hover:bg-violet-50 focus:bg-violet-50 focus:outline-none"
          >
            <FileJson className="h-4 w-4 text-violet-500" />
            JSON 审计文件
          </a>
          <a
            role="menuitem"
            href={`${baseUrl}?format=markdown`}
            download
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-indigo-800 hover:bg-violet-50 focus:bg-violet-50 focus:outline-none"
          >
            <FileText className="h-4 w-4 text-violet-500" />
            Markdown 报告
          </a>
          <div className="my-1 border-t border-violet-100" />
          {share ? (
            <>
              <div className="px-3 py-2">
                <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-indigo-900">
                  <Link className="h-3.5 w-3.5 text-violet-500" />
                  当前分享链接
                </p>
                <p className="mb-2 text-[11px] text-slate-500">
                  有效至 {new Date(share.expiresAt).toLocaleString('zh-CN')}
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  <button
                    type="button"
                    onClick={copyShare}
                    disabled={shareBusy}
                    title="复制分享链接"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-violet-200 px-2 py-1.5 text-xs text-indigo-700 hover:bg-violet-50 disabled:cursor-wait disabled:opacity-50"
                  >
                    <Clipboard className="h-3.5 w-3.5" />复制
                  </button>
                  <a
                    href={share.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setOpen(false)}
                    title="打开只读分享报告"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-violet-200 px-2 py-1.5 text-xs text-indigo-700 hover:bg-violet-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />打开
                  </a>
                  <button
                    type="button"
                    onClick={revokeShare}
                    disabled={shareBusy}
                    title="撤销分享链接"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-rose-200 px-2 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-50"
                  >
                    {shareBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5" />}撤销
                  </button>
                </div>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={createShare}
              disabled={shareBusy}
              role="menuitem"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-indigo-800 hover:bg-violet-50 focus:bg-violet-50 focus:outline-none disabled:cursor-wait disabled:opacity-60"
            >
              {shareBusy ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-500" /> : <Link className="h-4 w-4 text-violet-500" />}
              创建 24 小时分享链接
            </button>
          )}
          {shareMessage ? (
            <p role="status" className="flex items-center gap-1.5 px-3 pb-2 text-xs text-slate-500">
              {shareMessage.includes('已') ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : null}
              {shareMessage}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
