"use client";

interface Props {
  rootName: string;
  path: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ rootName, path, onNavigate }: Props) {
  const segments = path ? path.split("/").filter(Boolean) : [];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path || "");
    } catch {
      /* noop */
    }
  };

  return (
    <div className="fv-crumb">
      <button className="crumb-item root" onClick={() => onNavigate("")} title="루트">
        📁 {rootName}
      </button>
      {segments.map((seg, i) => {
        const cumulative = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={cumulative} className="crumb-row">
            <span className="crumb-sep">›</span>
            {isLast ? (
              <span className="crumb-item current">{seg}</span>
            ) : (
              <button className="crumb-item" onClick={() => onNavigate(cumulative)}>
                {seg}
              </button>
            )}
          </span>
        );
      })}
      {path ? (
        <button className="crumb-copy" onClick={copy} title="경로 복사">
          📋
        </button>
      ) : null}
    </div>
  );
}
