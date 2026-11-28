import { forwardRef, useId, type ButtonHTMLAttributes } from 'react';
import './styles/hint-button.css';

type HintButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  hint?: string;
  placement?: 'left' | 'right' | 'below' | 'above' | 'above-end';
};

/** Chromium's interest invoker handles hover, keyboard focus, Escape and top-layer positioning. */
export const HintButton = forwardRef<HTMLButtonElement, HintButtonProps>(
  function HintButton({ hint, placement = 'below', children, className = '', onClick, ...props }, ref) {
    const hintId = useId();
    return <>
      <button {...props} {...{ interestfor: hintId }} ref={ref} type="button"
        aria-describedby={hint ? hintId : undefined} className={`hint-trigger ${className}`}
        onClick={event => {
          document.getElementById(hintId)?.hidePopover();
          onClick?.(event);
        }}>
        {children}
      </button>
      <span id={hintId} {...{ popover: 'hint' }} role="tooltip" data-placement={placement}
        className="button-hint">{hint || props['aria-label']}</span>
    </>;
  },
);
