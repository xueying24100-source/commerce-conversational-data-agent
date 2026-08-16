import { Fingerprint } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';

export function EvidenceIds({
  ids,
  onNavigate,
}: {
  ids: string[];
  onNavigate?: (evidenceId: string) => void;
}) {
  if (!ids.length) return null;
  return (
    <details className="group mt-2 text-xs text-violet-700">
      <summary className="w-fit cursor-pointer list-none rounded-md px-1 py-0.5 font-medium transition hover:bg-violet-100 hover:text-violet-700">
        查看证据引用（{ids.length}）
      </summary>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {ids.map((id, index) => (
          <a
            key={id}
            href={`#evidence-${id}`}
            onClick={onNavigate ? (event) => {
              event.preventDefault();
              onNavigate(id);
            } : undefined}
            className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
            aria-label={`定位到证据 ${index + 1}`}
          >
            <Badge variant="primary" className="font-mono text-[10px] transition hover:bg-violet-200">
              <Fingerprint className="h-3 w-3" />
              证据 {index + 1} · {id.slice(0, 11)}
            </Badge>
          </a>
        ))}
      </div>
    </details>
  );
}
