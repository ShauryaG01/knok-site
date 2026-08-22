export function KnokLogo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-lg bg-green ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} viewBox="0 0 48 48" fill="none">
        <path d="M24 40V10A10 10 0 0 1 34 20V40Z" fill="#F0CE7A" />
        <path d="M14 40V20A10 10 0 0 1 34 20V40" stroke="#F2F1E9" strokeWidth="3" strokeLinejoin="round" />
        <circle cx="19.5" cy="29" r="2" fill="#F2F1E9" />
      </svg>
    </span>
  );
}
