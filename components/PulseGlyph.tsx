export function PulseGlyph({
  className,
  strokeWidth = 2,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg className={className} viewBox="0 0 32 18" fill="none" aria-hidden>
      <path
        d="M1 9 H9 L12 2 L16 16 L19.5 6 L22 9 H31"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
