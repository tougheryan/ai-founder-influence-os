import type { ReactNode } from 'react';

type FounderRevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  once?: boolean;
};

export function FounderReveal({ children, className }: FounderRevealProps) {
  return (
    <div className={className}>{children}</div>
  );
}
