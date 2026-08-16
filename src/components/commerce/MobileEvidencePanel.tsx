import { EvidenceTimeline, type EvidenceTimelineProps } from './EvidenceTimeline';
import { MobileDrawer } from './MobileDrawer';

export type MobileEvidencePanelProps = EvidenceTimelineProps & { onClose: () => void };

export function MobileEvidencePanel({ traces, pending, claims, currencyCode, onClose }: MobileEvidencePanelProps) {
  return (
    <MobileDrawer
      side="right"
      tone="light"
      title="证据栏"
      subtitle={`${traces.length} 条证据 · 全部轮次`}
      onClose={onClose}
      titleId="mobile-evidence-title"
    >
      <EvidenceTimeline
        traces={traces}
        pending={pending}
        claims={claims}
        currencyCode={currencyCode}
        className="p-4"
        idPrefix="mobile-evidence"
      />
    </MobileDrawer>
  );
}
