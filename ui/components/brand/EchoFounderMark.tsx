import Image from 'next/image';

type EchoFounderMarkProps = {
  alt?: string;
  className?: string;
  size?: number;
};

export function EchoFounderMark({ alt = '', className, size = 36 }: EchoFounderMarkProps) {
  return (
    <Image
      src="/icon.svg?v=precision-mark-5"
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className={className}
    />
  );
}
