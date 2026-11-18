import { useState, type DetailsHTMLAttributes, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import './styles/accordion.css';

type AccordionProps = Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> & {
  summary: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  compact?: boolean;
  defaultOpen?: boolean;
  summaryClassName?: string;
  children: ReactNode;
};

/** 共用折叠区：保留原生键盘行为，收起时不卸载表单或重置输入。 */
export function Accordion({ summary, description, badge, compact = false, defaultOpen = false,
  summaryClassName = '', className = '', open, onToggle, onInvalidCapture, children, ...props }: AccordionProps) {
  const [expanded, setExpanded] = useState(defaultOpen);
  return <details {...props} className={`pi-accordion${compact ? ' is-compact' : ''} ${className}`.trim()}
    open={open ?? expanded} onInvalidCapture={event => {
      // 在浏览器聚焦无效字段前展开，保留原生校验提示。
      event.currentTarget.open = true;
      setExpanded(true);
      onInvalidCapture?.(event);
    }} onToggle={event => {
      setExpanded(event.currentTarget.open);
      onToggle?.(event);
    }}>
    <summary className={`pi-accordion-trigger ${summaryClassName}`.trim()}>
      <span className="pi-accordion-copy">
        <span className="pi-accordion-label">{summary}{badge !== undefined && badge !== false && badge !== null
          && <span className="pi-accordion-badge">{badge}</span>}</span>
        {description && <span className="pi-accordion-description">{description}</span>}
      </span>
      <ChevronRight className="pi-accordion-chevron" aria-hidden="true" />
    </summary>
    {children}
  </details>;
}
