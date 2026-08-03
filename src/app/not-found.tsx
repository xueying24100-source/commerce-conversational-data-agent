import Link from 'next/link';
import { ArrowLeft, Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="platform-shell flex min-h-dvh items-center justify-center px-4 py-12">
      <section className="platform-card w-full max-w-lg px-6 py-10 text-center sm:px-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Compass className="h-7 w-7" />
        </div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.24em] text-primary">404 · Route not found</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">这个页面不在当前航线中</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          地址可能已更新。当前项目只保留电商经营 Data Agent 工作台。
        </p>
        <Link
          href="/commerce"
          className="mx-auto mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          <ArrowLeft className="h-4 w-4" />
          返回经营工作台
        </Link>
      </section>
    </main>
  );
}
