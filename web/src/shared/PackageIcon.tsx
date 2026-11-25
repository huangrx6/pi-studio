import { Package } from 'lucide-react';

export function PackageIcon({ source, fallback = true, name }: { source?: string; fallback?: boolean; name?: string }) {
  if (source?.startsWith('data:image/png;base64,')) {
    return <img className="studio-package-mark" src={source} alt="" width={16} height={16} draggable={false} />;
  }
  if (!fallback) return null;
  const words = name?.match(/[\p{L}\p{N}]+/gu);
  if (words?.length) {
    const initials = words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
    return <span className="plugin-package-initials" aria-hidden="true">{initials}</span>;
  }
  return <Package aria-hidden="true" />;
}
