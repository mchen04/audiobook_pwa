type BrandMarkProps = {
  compact?: boolean;
};

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <span className="brand-mark" aria-label="Chapterline">
      <span className="brand-symbol" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact && <span className="brand-name">Chapterline</span>}
    </span>
  );
}
